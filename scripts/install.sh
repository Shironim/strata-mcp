#!/usr/bin/env bash
# Strata Standalone Binary Installer for Linux and macOS
# Usage:
#   curl -fsSL https://raw.githubusercontent.com/Shironim/strata-mcp/master/scripts/install.sh | bash
#
# Environment variables:
#   STRATA_VERSION: Specific version tag to install (default: latest release)
#   STRATA_INSTALL_DIR: Target directory for binaries (default: ~/.local/bin or /usr/local/bin)
#   STRATA_REPO: GitHub repository slug (default: Shironim/strata-mcp)

set -euo pipefail

BOLD="$(tput bold 2>/dev/null || printf '')"
GREEN="$(tput setaf 2 2>/dev/null || printf '')"
YELLOW="$(tput setaf 3 2>/dev/null || printf '')"
RED="$(tput setaf 1 2>/dev/null || printf '')"
CYAN="$(tput setaf 6 2>/dev/null || printf '')"
RESET="$(tput sgr0 2>/dev/null || printf '')"

REPO="${STRATA_REPO:-Shironim/strata-mcp}"

print_step() {
  printf "${CYAN}==>${RESET} ${BOLD}%s${RESET}\n" "$1"
}

print_success() {
  printf "${GREEN}✔${RESET} %s\n" "$1"
}

print_warning() {
  printf "${YELLOW}⚠${RESET} %s\n" "$1"
}

print_error() {
  printf "${RED}✘ Error:${RESET} %s\n" "$1" >&2
}

# 1. Detect Operating System
OS="$(uname -s)"
case "${OS}" in
  Linux*)  TARGET_OS="linux" ;;
  Darwin*) TARGET_OS="darwin" ;;
  *)
    print_error "Unsupported operating system: ${OS}. Strata standalone binary supports Linux and macOS."
    exit 1
    ;;
esac

# 2. Detect CPU Architecture
ARCH="$(uname -m)"
case "${ARCH}" in
  x86_64|amd64) TARGET_ARCH="x64" ;;
  arm64|aarch64) TARGET_ARCH="arm64" ;;
  *)
    print_error "Unsupported architecture: ${ARCH}. Supported architectures: x64, arm64."
    exit 1
    ;;
esac

BINARY_NAME="strata-${TARGET_OS}-${TARGET_ARCH}"

# 3. Determine Installation Directory
if [ -n "${STRATA_INSTALL_DIR:-}" ]; then
  INSTALL_DIR="${STRATA_INSTALL_DIR}"
elif [ "$(id -u)" -eq 0 ] && [ -w "/usr/local/bin" ]; then
  INSTALL_DIR="/usr/local/bin"
else
  INSTALL_DIR="${HOME}/.local/bin"
fi

mkdir -p "${INSTALL_DIR}"

# 4. Resolve Target Release Version
print_step "Detecting latest Strata release from ${REPO}..."
if [ -z "${STRATA_VERSION:-}" ]; then
  LATEST_RELEASE_URL="https://api.github.com/repos/${REPO}/releases/latest"
  if command -v curl >/dev/null 2>&1; then
    VERSION_TAG=$(curl -sSL -H "Accept: application/vnd.github.v3+json" "${LATEST_RELEASE_URL}" | grep '"tag_name":' | head -n 1 | sed -E 's/.*"([^"]+)".*/\1/' || true)
  elif command -v wget >/dev/null 2>&1; then
    VERSION_TAG=$(wget -qO- "${LATEST_RELEASE_URL}" | grep '"tag_name":' | head -n 1 | sed -E 's/.*"([^"]+)".*/\1/' || true)
  fi

  if [ -z "${VERSION_TAG:-}" ] || [ "${VERSION_TAG}" = "null" ]; then
    print_warning "Could not query GitHub API for latest release tag. Falling back to 'latest' release assets."
    DOWNLOAD_BASE="https://github.com/${REPO}/releases/latest/download"
  else
    DOWNLOAD_BASE="https://github.com/${REPO}/releases/download/${VERSION_TAG}"
  fi
else
  VERSION_TAG="${STRATA_VERSION}"
  DOWNLOAD_BASE="https://github.com/${REPO}/releases/download/${VERSION_TAG}"
fi

# 5. Create Temporary Workspace
TMP_DIR="$(mktemp -d -t strata-install-XXXXXX)"
cleanup() {
  rm -rf "${TMP_DIR}"
}
trap cleanup EXIT INT TERM

# 6. Download Binary and Checksums
DOWNLOAD_URL="${DOWNLOAD_BASE}/${BINARY_NAME}"
CHECKSUMS_URL="${DOWNLOAD_BASE}/checksums.txt"

print_step "Downloading ${BINARY_NAME}..."
if command -v curl >/dev/null 2>&1; then
  curl -fSL --progress-bar "${DOWNLOAD_URL}" -o "${TMP_DIR}/${BINARY_NAME}" || {
    print_error "Failed to download binary from ${DOWNLOAD_URL}"
    exit 1
  }
  curl -sSL "${CHECKSUMS_URL}" -o "${TMP_DIR}/checksums.txt" || true
elif command -v wget >/dev/null 2>&1; then
  wget -q --show-progress "${DOWNLOAD_URL}" -O "${TMP_DIR}/${BINARY_NAME}" || {
    print_error "Failed to download binary from ${DOWNLOAD_URL}"
    exit 1
  }
  wget -q "${CHECKSUMS_URL}" -O "${TMP_DIR}/checksums.txt" || true
else
  print_error "Neither curl nor wget was found. Please install curl or wget."
  exit 1
fi

# 7. Checksum Verification (if checksums.txt exists)
if [ -f "${TMP_DIR}/checksums.txt" ] && [ -s "${TMP_DIR}/checksums.txt" ]; then
  print_step "Verifying SHA-256 checksum..."
  EXPECTED_HASH=$(grep "${BINARY_NAME}" "${TMP_DIR}/checksums.txt" | awk '{print $1}' || true)
  if [ -n "${EXPECTED_HASH}" ]; then
    if command -v sha256sum >/dev/null 2>&1; then
      ACTUAL_HASH=$(sha256sum "${TMP_DIR}/${BINARY_NAME}" | awk '{print $1}')
    elif command -v shasum >/dev/null 2>&1; then
      ACTUAL_HASH=$(shasum -a 256 "${TMP_DIR}/${BINARY_NAME}" | awk '{print $1}')
    else
      ACTUAL_HASH=""
    fi

    if [ -n "${ACTUAL_HASH}" ]; then
      if [ "${EXPECTED_HASH}" != "${ACTUAL_HASH}" ]; then
        print_error "Checksum verification failed!"
        print_error "Expected: ${EXPECTED_HASH}"
        print_error "Actual:   ${ACTUAL_HASH}"
        exit 1
      fi
      print_success "Checksum verified: ${ACTUAL_HASH:0:16}..."
    fi
  fi
fi

# 8. Install Binary
chmod +x "${TMP_DIR}/${BINARY_NAME}"
mv -f "${TMP_DIR}/${BINARY_NAME}" "${INSTALL_DIR}/strata"

print_success "Installed strata binary to ${INSTALL_DIR}/strata"

# 9. Check PATH Configuration
case ":${PATH}:" in
  *:"${INSTALL_DIR}":*) ;;
  *)
    printf "\n${YELLOW}Note:${RESET} ${INSTALL_DIR} is not in your PATH.\n"
    printf "To execute 'strata' directly from anywhere, add this line to your ~/.bashrc, ~/.zshrc, or profile:\n"
    printf "  ${BOLD}export PATH=\"%s:\$PATH\"${RESET}\n\n" "${INSTALL_DIR}"
    ;;
esac

# 10. Final Success Banner
printf "\n${GREEN}${BOLD}✨ Strata MCP installed successfully!${RESET}\n"
printf "Run '${CYAN}strata --help${RESET}' to get started or configure it in your MCP client:\n\n"
printf "  ${BOLD}Command:${RESET} %s/strata\n" "${INSTALL_DIR}"
printf "  ${BOLD}Args:${RESET} [\"serve\"]\n\n"

