import { createHash } from 'node:crypto';
import { promises as fs } from 'node:fs';
import { extractTier1File, type Tier1ExtractionResult } from './symbol-extractor';
import type { WorkspacePackageInfo } from './workspace-packages';

export interface ParseWorkItem {
  filePath: string;
  pkgKey: string;
  mtime: number;
  size: number;
  isNew: boolean;
  prevId?: number;
  prevContentHash?: string;
}

export interface WorkerInitMessage {
  type: 'init';
  allPackages: WorkspacePackageInfo[];
  knownFiles: string[];
  force: boolean;
}

export interface WorkerChunkMessage {
  type: 'chunk';
  chunkId: number;
  items: ParseWorkItem[];
}

export type WorkerInboundMessage = WorkerInitMessage | WorkerChunkMessage;

export interface ExtractedWorkResult {
  result: Tier1ExtractionResult;
  pkgKey: string;
  mtime: number;
  size: number;
  isNew: boolean;
}

export interface MtimeOnlyUpdate {
  id: number;
  mtime: number;
  size: number;
}

export type WorkerOutboundMessage =
  | { type: 'ready' }
  | {
      type: 'chunkResult';
      chunkId: number;
      extracted: ExtractedWorkResult[];
      mtimeOnlyUpdates: MtimeOnlyUpdate[];
      parsedCount: number;
    }
  | { type: 'error'; chunkId?: number; message: string };

declare const self: Worker;

let allPackages: WorkspacePackageInfo[] = [];
let pkgByKey = new Map<string, WorkspacePackageInfo>();
let knownFilesSet = new Set<string>();
let forceMode = false;
let importCache = new Map<string, string | undefined>();

self.onmessage = async (event: MessageEvent<WorkerInboundMessage>) => {
  const msg = event.data;
  try {
    if (msg.type === 'init') {
      allPackages = msg.allPackages;
      pkgByKey = new Map(allPackages.map((p) => [p.packageKey, p]));
      knownFilesSet = new Set(msg.knownFiles);
      forceMode = msg.force;
      importCache = new Map();
      self.postMessage({ type: 'ready' } satisfies WorkerOutboundMessage);
      return;
    }

    if (msg.type === 'chunk') {
      const contents = await Promise.all(msg.items.map((item) => fs.readFile(item.filePath, 'utf8')));
      const extracted: ExtractedWorkResult[] = [];
      const mtimeOnlyUpdates: MtimeOnlyUpdate[] = [];
      let parsedCount = 0;

      for (let i = 0; i < msg.items.length; i++) {
        const item = msg.items[i]!;
        const content = contents[i]!;
        const contentHash = createHash('sha256').update(content).digest('hex');

        if (!forceMode && item.prevId !== undefined && item.prevContentHash === contentHash) {
          mtimeOnlyUpdates.push({ id: item.prevId, mtime: item.mtime, size: item.size });
          parsedCount++;
          continue;
        }

        const pkg = pkgByKey.get(item.pkgKey);
        if (!pkg) {
          parsedCount++;
          continue;
        }

        const res = extractTier1File(
          item.filePath,
          content,
          pkg,
          allPackages,
          contentHash,
          importCache,
          knownFilesSet
        );
        parsedCount++;
        if (!res) continue;

        extracted.push({
          result: res,
          pkgKey: item.pkgKey,
          mtime: item.mtime,
          size: item.size,
          isNew: item.isNew,
        });
      }

      self.postMessage({
        type: 'chunkResult',
        chunkId: msg.chunkId,
        extracted,
        mtimeOnlyUpdates,
        parsedCount,
      } satisfies WorkerOutboundMessage);
    }
  } catch (err) {
    self.postMessage({
      type: 'error',
      chunkId: msg.type === 'chunk' ? msg.chunkId : undefined,
      message: err instanceof Error ? err.message : String(err),
    } satisfies WorkerOutboundMessage);
  }
};
