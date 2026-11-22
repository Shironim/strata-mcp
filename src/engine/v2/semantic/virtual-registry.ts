import { existsSync, readFileSync, statSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { defaultPluginRegistry, type VirtualDocument } from '../../../plugins';
import { lineStarts } from '../../../utils/source-position';
import { canonicalizePath } from '../../path-resolver';

interface CachedVirtualEntry {
  mtimeMs: number;
  size: number;
  rawContent: string;
  doc: VirtualDocument;
  lineStarts?: number[];
}

export interface VirtualRegistryEntry {
  doc: VirtualDocument;
  rawContent: string;
  getLineStarts(): number[];
}

const VIRTUAL_SUFFIX = '.__strata__.tsx';

export function isVirtualTsxPath(filePath: string): boolean {
  return filePath.endsWith(VIRTUAL_SUFFIX);
}

export function stripVirtualTsxSuffix(filePath: string): string {
  return isVirtualTsxPath(filePath) ? filePath.slice(0, -VIRTUAL_SUFFIX.length) : filePath;
}

/**
 * Caches projected VirtualDocuments keyed by canonical originalPath with (mtime, size) invalidation,
 * and maps between virtualPath <-> originalPath for StrataLanguageServiceHost.
 */
export class VirtualFileRegistry {
  private readonly byOriginal = new Map<string, CachedVirtualEntry>();
  private readonly originalByVirtual = new Map<string, string>();

  private toEntry(cached: CachedVirtualEntry): VirtualRegistryEntry {
    return {
      doc: cached.doc,
      rawContent: cached.rawContent,
      getLineStarts: () => (cached.lineStarts ??= lineStarts(cached.rawContent)),
    };
  }

  getForOriginal(filePath: string): VirtualRegistryEntry | null {
    const abs = canonicalizePath(filePath);
    if (!existsSync(abs)) return null;

    let st;
    try {
      st = statSync(abs);
      if (!st.isFile()) return null;
    } catch {
      return null;
    }

    const cached = this.byOriginal.get(abs);
    if (cached && cached.mtimeMs === st.mtimeMs && cached.size === st.size) {
      return this.toEntry(cached);
    }

    const rawContent = readFileSync(abs, 'utf8');
    const sourceHash = createHash('sha256').update(rawContent).digest('hex');
    const doc = defaultPluginRegistry.projectFile(abs, rawContent, sourceHash);
    if (!doc) return null;

    const entry: CachedVirtualEntry = {
      mtimeMs: st.mtimeMs,
      size: st.size,
      rawContent,
      doc,
    };
    this.byOriginal.set(abs, entry);
    this.originalByVirtual.set(doc.virtualPath, abs);

    return this.toEntry(entry);
  }

  getForVirtual(virtualOrRealPath: string): VirtualRegistryEntry | null {
    const original =
      this.originalByVirtual.get(virtualOrRealPath) ?? stripVirtualTsxSuffix(virtualOrRealPath);
    return this.getForOriginal(original);
  }

  resolveOriginalPath(virtualOrRealPath: string): string {
    return this.originalByVirtual.get(virtualOrRealPath) ?? stripVirtualTsxSuffix(virtualOrRealPath);
  }

  invalidate(filePath: string): void {
    const abs = canonicalizePath(filePath);
    const cached = this.byOriginal.get(abs);
    if (cached) {
      this.originalByVirtual.delete(cached.doc.virtualPath);
      this.byOriginal.delete(abs);
    }
  }

  clear(): void {
    this.byOriginal.clear();
    this.originalByVirtual.clear();
  }
}
