# Strata Standalone Binary Installer for Windows PowerShell
# Usage:
#   irm https://raw.githubusercontent.com/Shironim/strata-mcp/master/scripts/install.ps1 | iex
#
# Optional parameters via environment variables:
#   $env:STRATA_VERSION: Specific version tag to install (default: latest release)
#   $env:STRATA_INSTALL_DIR: Target directory for binaries (default: $env:LOCALAPPDATA\Programs\strata)
#   $env:STRATA_REPO: GitHub repository slug (default: Shironim/strata-mcp)

[CmdletBinding()]
param (
    [string]$Version = $env:STRATA_VERSION,
    [string]$InstallDir = $env:STRATA_INSTALL_DIR,
    [string]$Repo = $(if ($env:STRATA_REPO) { $env:STRATA_REPO } else { "Shironim/strata-mcp" })
)

$ErrorActionPreference = 'Stop'
[Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12

function Write-Step {
    param([string]$Message)
    Write-Host "==> " -ForegroundColor Cyan -NoNewline
    Write-Host $Message -ForegroundColor White
}

function Write-Success {
    param([string]$Message)
    Write-Host "✔ " -ForegroundColor Green -NoNewline
    Write-Host $Message
}

function Write-Warn {
    param([string]$Message)
    Write-Host "⚠ " -ForegroundColor Yellow -NoNewline
    Write-Host $Message
}

function Write-Err {
    param([string]$Message)
    Write-Host "✘ Error: " -ForegroundColor Red -NoNewline
    Write-Host $Message
}

# 1. Architecture Check
if (-not [Environment]::Is64BitOperatingSystem) {
    Write-Err "Strata standalone binary requires 64-bit Windows."
    exit 1
}

$BinaryName = "strata-windows-x64.exe"

# 2. Determine Installation Directory
if (-not $InstallDir) {
    $InstallDir = Join-Path $env:LOCALAPPDATA "Programs\strata"
}

if (-not (Test-Path $InstallDir)) {
    New-Item -ItemType Directory -Path $InstallDir -Force | Out-Null
}

# 3. Determine Target Release Version
Write-Step "Detecting latest Strata release from $Repo..."
$DownloadBase = ""

if (-not $Version) {
    try {
        $ReleaseInfo = Invoke-RestMethod -Uri "https://api.github.com/repos/$Repo/releases/latest" -Headers @{ "Accept" = "application/vnd.github.v3+json" }
        $VersionTag = $ReleaseInfo.tag_name
        $DownloadBase = "https://github.com/$Repo/releases/download/$VersionTag"
        Write-Step "Resolved release version: $VersionTag"
    } catch {
        Write-Warn "Could not query GitHub API for latest release tag. Falling back to latest release assets."
        $DownloadBase = "https://github.com/$Repo/releases/latest/download"
    }
} else {
    $DownloadBase = "https://github.com/$Repo/releases/download/$Version"
}

# 4. Create Temporary Directory
$TempDir = Join-Path ([System.IO.Path]::GetTempPath()) ("strata-install-" + [System.Guid]::NewGuid().ToString().Substring(0, 8))
New-Item -ItemType Directory -Path $TempDir -Force | Out-Null

try {
    # 5. Download Binary & Checksums
    $BinaryUrl = "$DownloadBase/$BinaryName"
    $ChecksumsUrl = "$DownloadBase/checksums.txt"
    $TempBinaryPath = Join-Path $TempDir $BinaryName
    $TempChecksumsPath = Join-Path $TempDir "checksums.txt"

    Write-Step "Downloading $BinaryName..."
    Invoke-WebRequest -Uri $BinaryUrl -OutFile $TempBinaryPath -UseBasicParsing

    try {
        Invoke-WebRequest -Uri $ChecksumsUrl -OutFile $TempChecksumsPath -UseBasicParsing
    } catch {
        # Optional checksum file
    }

    # 6. Checksum Verification
    if (Test-Path $TempChecksumsPath) {
        Write-Step "Verifying SHA-256 checksum..."
        $ChecksumContent = Get-Content $TempChecksumsPath
        $MatchingLine = $ChecksumContent | Where-Object { $_ -match $BinaryName }
        if ($MatchingLine) {
            $ExpectedHash = ($MatchingLine -split '\s+')[0].Trim().ToLower()
            $ActualHash = (Get-FileHash -Path $TempBinaryPath -Algorithm SHA256).Hash.ToLower()

            if ($ExpectedHash -ne $ActualHash) {
                Write-Err "Checksum verification failed!"
                Write-Err "Expected: $ExpectedHash"
                Write-Err "Actual:   $ActualHash"
                exit 1
            }
            Write-Success "Checksum verified: $($ActualHash.Substring(0, 16))..."
        }
    }

    # 7. Move Executable into Place
    $TargetExe = Join-Path $InstallDir "strata.exe"
    $TargetMcpExe = Join-Path $InstallDir "strata-mcp.exe"

    Copy-Item -Path $TempBinaryPath -Destination $TargetExe -Force
    Copy-Item -Path $TempBinaryPath -Destination $TargetMcpExe -Force

    Write-Success "Installed binary to $TargetExe"
    Write-Success "Created alias binary $TargetMcpExe"

    # 8. Check and Auto-Provision ast-grep.exe
    $AstGrepInstalled = Get-Command ast-grep -ErrorAction SilentlyContinue
    if (-not $AstGrepInstalled) {
        $AstGrepInstalled = Get-Command sg -ErrorAction SilentlyContinue
    }

    if (-not $AstGrepInstalled) {
        Write-Warn "ast-grep binary was not found in PATH."
        Write-Step "Attempting automatic download of companion ast-grep.exe..."

        $AstGrepVersion = "0.45.3"
        $AstGrepZipUrl = "https://github.com/ast-grep/ast-grep/releases/download/$AstGrepVersion/app-x86_64-pc-windows-msvc.zip"
        $AstGrepZip = Join-Path $TempDir "ast-grep.zip"

        try {
            Invoke-WebRequest -Uri $AstGrepZipUrl -OutFile $AstGrepZip -UseBasicParsing
            Expand-Archive -Path $AstGrepZip -DestinationPath $TempDir -Force
            $ExtractedAstGrep = Join-Path $TempDir "ast-grep.exe"
            if (Test-Path $ExtractedAstGrep) {
                Copy-Item -Path $ExtractedAstGrep -Destination (Join-Path $InstallDir "ast-grep.exe") -Force
                Write-Success "Installed companion ast-grep.exe into $InstallDir"
            }
        } catch {
            Write-Warn "Could not automatically download ast-grep.exe. You can install it manually from https://ast-grep.github.io/"
        }
    }

    # 9. Ensure InstallDir is in User PATH
    $UserPath = [Environment]::GetEnvironmentVariable("Path", [EnvironmentVariableTarget]::User)
    $PathEntries = $UserPath -split ';' | Where-Object { $_ -ne '' }

    if ($PathEntries -notcontains $InstallDir) {
        Write-Step "Adding $InstallDir to user PATH environment variable..."
        $NewPath = "$UserPath;$InstallDir"
        [Environment]::SetEnvironmentVariable("Path", $NewPath, [EnvironmentVariableTarget]::User)
        $env:Path = "$env:Path;$InstallDir"
        Write-Success "Added to PATH. (You may need to restart existing terminal sessions)"
    }

    # 10. Done Banner
    Write-Host ""
    Write-Host "✨ Strata MCP installed successfully!" -ForegroundColor Green
    Write-Host "You can now run 'strata --help' or configure it in your MCP client:" -ForegroundColor White
    Write-Host ""
    Write-Host "  Binary Path: $TargetExe" -ForegroundColor Cyan
    Write-Host ""
} finally {
    if (Test-Path $TempDir) {
        Remove-Item -Path $TempDir -Recurse -Force -ErrorAction SilentlyContinue
    }
}
