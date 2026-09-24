import { existsSync, promises as fs, statSync } from 'node:fs';
import { basename, dirname, isAbsolute, join, normalize, resolve } from 'node:path';

/**
 * Root markers indicating the root boundary of a frontend or fullstack project.
 */
export const PROJECT_ROOT_MARKERS = [
  'package.json',
  'composer.json',
  '.git',
  'pnpm-workspace.yaml',
  'lerna.json',
  'jsconfig.json',
  'tsconfig.json',
  'nuxt.config.ts',
  'nuxt.config.js',
  'next.config.js',
  'next.config.mjs',
  'next.config.ts',
  'astro.config.mjs',
  'astro.config.ts',
  'vite.config.ts',
  'vite.config.js',
  'vite.config.mjs',
];

/**
 * In-memory session store for the most recently identified or active project root.
 */
let lastKnownProjectRoot: string | undefined;

/**
 * Canonicalizes a file or directory path for cross-platform consistency:
 * - Resolves to absolute path and normalizes separators.
 * - Uppercases Windows drive letters (e.g. "c:\" -> "C:\") to eliminate map lookup misses.
 */
export function canonicalizePath(targetPath: string): string {
  if (!targetPath || typeof targetPath !== 'string') {
    return targetPath;
  }
  let abs = normalize(resolve(targetPath));
  if (process.platform === 'win32') {
    abs = abs.replace(/^[a-zA-Z]:/, (m) => m.toUpperCase());
  }
  return abs;
}

export function setLastKnownProjectRoot(root: string): void {
  if (root && typeof root === 'string') {
    lastKnownProjectRoot = canonicalizePath(root);
  }
}

export function getLastKnownProjectRoot(): string | undefined {
  return lastKnownProjectRoot;
}

export function clearLastKnownProjectRoot(): void {
  lastKnownProjectRoot = undefined;
}

/**
 * Discovers the project root directory by walking up looking for marker files
 * (package.json, composer.json, .git, config files).
 */
export function findProjectRoot(fromPath: string): string {
  try {
    let dir = resolve(fromPath);

    // If fromPath points to a file or doesn't exist, start from its directory
    if (existsSync(dir)) {
      const stat = statSync(dir);
      if (!stat.isDirectory()) {
        dir = dirname(dir);
      }
    } else {
      dir = dirname(dir);
    }

    while (true) {
      for (const marker of PROJECT_ROOT_MARKERS) {
        if (existsSync(join(dir, marker))) {
          return dir;
        }
      }
      const parent = dirname(dir);
      if (parent === dir) break;
      dir = parent;
    }
  } catch {
    // Filesystem traversal error fallback
  }

  return dirname(resolve(fromPath));
}

/**
 * Resolves a file or directory path ergonomically:
 * 1. If absolute and exists: returns normalized path and updates last known root.
 * 2. If relative:
 *    a. Checks against rootHint (if provided).
 *    b. Checks against lastKnownProjectRoot (if available).
 *    c. Checks against process.cwd().
 *    d. Falls back to resolving against lastKnownProjectRoot or process.cwd().
 */
export function resolveWorkspacePath(rawPath: string, rootHint?: string): string {
  if (!rawPath || typeof rawPath !== 'string') {
    return lastKnownProjectRoot || canonicalizePath(process.cwd());
  }

  const trimmed = rawPath.trim().replace(/^['"]|['"]$/g, '');
  if (!trimmed) {
    return lastKnownProjectRoot || canonicalizePath(process.cwd());
  }

  // Cross-platform: convert Windows backslashes to forward slashes for segment resolution
  const normalizedSlashes = trimmed.replace(/\\/g, '/');

  // Helper to check if a path is truly an absolute path with drive or UNC on Windows
  const isWindowsAbsolute = /^[A-Za-z]:[\\/]/.test(trimmed) || trimmed.startsWith('\\\\');
  const isPosixAbsolute = trimmed.startsWith('/') && !process.platform.startsWith('win');

  // If candidate is a genuine full absolute path
  if (isWindowsAbsolute || isPosixAbsolute) {
    const norm = canonicalizePath(trimmed);
    if (existsSync(norm)) {
      const detectedRoot = findProjectRoot(norm);
      if (detectedRoot) {
        setLastKnownProjectRoot(detectedRoot);
      }
      return norm;
    }
  }

  // Candidate 1: Check against rootHint if provided (handles both "src/..." and "/src/...")
  if (rootHint) {
    const resolvedHint = canonicalizePath(rootHint.trim().replace(/^['"]|['"]$/g, ''));
    const relativePart = normalizedSlashes.replace(/^[/\\]+/, '');
    const candidate = canonicalizePath(resolve(resolvedHint, relativePart));
    if (existsSync(candidate)) {
      setLastKnownProjectRoot(resolvedHint);
      return candidate;
    }
    // Also test direct join without stripping if rootHint was a directory
    const directCandidate = canonicalizePath(resolve(resolvedHint, normalizedSlashes));
    if (existsSync(directCandidate)) {
      setLastKnownProjectRoot(resolvedHint);
      return directCandidate;
    }
  }

  // Candidate 2: Check against lastKnownProjectRoot
  if (lastKnownProjectRoot) {
    const relativePart = normalizedSlashes.replace(/^[/\\]+/, '');
    const candidate = canonicalizePath(resolve(lastKnownProjectRoot, relativePart));
    if (existsSync(candidate)) {
      return candidate;
    }
  }

  // Candidate 3: Check against process.cwd()
  const cwdRelative = normalizedSlashes.replace(/^[/\\]+/, '');
  const cwdCandidate = canonicalizePath(resolve(process.cwd(), cwdRelative));
  if (existsSync(cwdCandidate)) {
    const detectedRoot = findProjectRoot(cwdCandidate);
    if (detectedRoot) {
      setLastKnownProjectRoot(detectedRoot);
    }
    return cwdCandidate;
  }

  // Candidate 4: Standard Node isAbsolute check fallback
  if (isAbsolute(trimmed)) {
    const norm = canonicalizePath(trimmed);
    if (existsSync(norm)) {
      return norm;
    }
  }

  // Fallback: If not found on disk, resolve against best available root
  const baseDir = rootHint
    ? canonicalizePath(rootHint.trim().replace(/^['"]|['"]$/g, ''))
    : (lastKnownProjectRoot || canonicalizePath(process.cwd()));

  const relativePart = normalizedSlashes.replace(/^[/\\]+/, '');
  return canonicalizePath(resolve(baseDir, relativePart));
}

/**
 * Resolves project root directory for workspace-level operations (e.g. audit_frontend, trace_state).
 * If targetPath is not provided or is ".", automatically falls back to lastKnownProjectRoot or auto-detected root of cwd.
 */
export function resolveProjectRoot(targetPath?: string): string {
  if (targetPath && targetPath !== '.') {
    const resolved = resolveWorkspacePath(targetPath);
    if (existsSync(resolved)) {
      const stat = statSync(resolved);
      const dir = canonicalizePath(stat.isDirectory() ? resolved : dirname(resolved));
      setLastKnownProjectRoot(dir);
      return dir;
    }
    return resolved;
  }

  if (lastKnownProjectRoot) {
    return lastKnownProjectRoot;
  }

  const detectedFromCwd = findProjectRoot(process.cwd());
  if (detectedFromCwd) {
    setLastKnownProjectRoot(detectedFromCwd);
    return detectedFromCwd;
  }

  return canonicalizePath(process.cwd());
}

/**
 * Ergonomically resolves a workspace target path from MCP tool arguments.
 * Supports camelCase (targetPath) and snake_case (target_path, path) aliases.
 */
export function resolveToolTargetPath(
  args: Record<string, any>,
  defaultPath = '.'
): string {
  const rawPath =
    typeof args?.targetPath === 'string'
      ? args.targetPath
      : typeof args?.target_path === 'string'
      ? args.target_path
      : typeof args?.path === 'string'
      ? args.path
      : defaultPath;
  return resolveWorkspacePath(rawPath);
}
