import { createHash } from 'node:crypto';
import { isAbsolute, relative, resolve } from 'node:path';
import { canonicalizePath } from '../path-resolver';
import { ValidationError, WorkspaceBoundaryError } from './errors';

export interface ParsedSourceRef {
  filePath: string;
  hashPrefix: string;
  startOffset: number;
  endOffset: number;
}

export function shortHash(content: string): string {
  return createHash('sha256').update(content).digest('hex').slice(0, 8);
}

export function shortHashFromFull(fullSha256: string): string {
  return fullSha256.slice(0, 8);
}

/**
 * Encodes a deterministic, hash-verified source reference string:
 * `ref:<hash8>:<startOffset>-<endOffset>@<relOrAbsPath>`
 */
export function formatSourceRef(
  filePath: string,
  hashPrefix: string,
  startOffset: number,
  endOffset: number
): string {
  const safeStart = Math.max(0, Math.trunc(startOffset));
  const safeEnd = Math.max(safeStart, Math.trunc(endOffset));
  return `ref:${hashPrefix.slice(0, 8)}:${safeStart}-${safeEnd}@${filePath.replace(/\\/g, '/')}`;
}

export function parseSourceRef(rawRef: string): ParsedSourceRef {
  const match = /^ref:([a-f0-9]{8}):(\d+)-(\d+)@(.+)$/i.exec(rawRef.trim());
  if (!match) {
    throw new ValidationError(`Invalid sourceRef format: "${rawRef}"`);
  }
  const startOffset = Number.parseInt(match[2], 10);
  const endOffset = Number.parseInt(match[3], 10);
  if (endOffset < startOffset) {
    throw new ValidationError(`Invalid sourceRef offset range: ${startOffset}-${endOffset}`);
  }
  return {
    hashPrefix: match[1].toLowerCase(),
    startOffset,
    endOffset,
    filePath: match[4],
  };
}

/**
 * Resolves a requested path against workspaceRoot and rejects path traversal outside the workspace.
 */
export function resolvePathWithinWorkspace(workspaceRoot: string, requestedPath: string): string {
  const absRoot = canonicalizePath(workspaceRoot);
  const candidate = isAbsolute(requestedPath)
    ? canonicalizePath(requestedPath)
    : canonicalizePath(resolve(absRoot, requestedPath));

  const rel = relative(absRoot, candidate);
  if (rel === '..' || rel.startsWith(`..${process.platform === 'win32' ? '\\' : '/'}`) || isAbsolute(rel)) {
    throw new WorkspaceBoundaryError(
      `Requested path "${requestedPath}" resolves outside workspace root "${absRoot}".`,
      { workspaceRoot: absRoot, requestedPath }
    );
  }
  return candidate;
}
