import { cpSync, existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { closeAllDatabases } from '../../src/engine/database';

const FIXTURES_SOURCE_DIR = join(import.meta.dir, '../fixtures');

export function writeWorkspaceFiles(root: string, files: Record<string, string>): void {
  for (const [relPath, content] of Object.entries(files)) {
    const absPath = join(root, relPath);
    mkdirSync(dirname(absPath), { recursive: true });
    writeFileSync(absPath, content, 'utf8');
  }
}

export function createWorkspaceTracker() {
  const roots: string[] = [];

  return {
    create(prefix = 'strata-test-', files?: Record<string, string>): string {
      const root = mkdtempSync(join(tmpdir(), prefix));
      roots.push(root);
      if (files) {
        writeWorkspaceFiles(root, files);
      }
      return root;
    },

    copyFixtures(prefix = 'strata-fixtures-'): string {
      const root = mkdtempSync(join(tmpdir(), prefix));
      roots.push(root);
      cpSync(FIXTURES_SOURCE_DIR, root, {
        recursive: true,
        filter: (src) => !src.includes('.strata'),
      });
      return root;
    },

    cleanupAll(): void {
      closeAllDatabases();
      for (const root of roots.splice(0)) {
        if (existsSync(root)) {
          rmSync(root, { recursive: true, force: true });
        }
      }
    },
  };
}

export async function captureConsoleLog(fn: () => Promise<void> | void): Promise<string[]> {
  const logs: string[] = [];
  const originalLog = console.log;
  console.log = (...args: unknown[]) => logs.push(args.map(String).join(' '));
  try {
    await fn();
  } finally {
    console.log = originalLog;
  }
  return logs;
}
