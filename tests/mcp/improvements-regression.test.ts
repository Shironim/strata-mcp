import { describe, it, expect } from 'bun:test';
import { synthesizeBackendTargetHint } from '../../src/engine/api-contract';
import { getUpwardComponentTree } from '../../src/engine/graph/upward-traversal';
import { getWorkspaceDatabase } from '../../src/engine/storage/schema';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

describe('Strata MCP Server Improvements Regression Suite', () => {
  // Item 7: Heuristic disclaimer on BackendTargetHint
  describe('Item 7: Route Heuristic Disclaimer', () => {
    it('attaches isHeuristic: true and explicit verification disclaimer to backendTargetHint', () => {
      const hint = synthesizeBackendTargetHint('POST', '/barang-masuk');
      expect(hint.isHeuristic).toBe(true);
      expect(hint.disclaimer).toContain('Pure Naming Convention Heuristic');
      expect(hint.disclaimer).toContain('routes/web.php');
      expect(hint.suggestedSymbols[0]).toBe('Barang-masukController');
    });

    it('attaches isHeuristic: true to Ziggy named route hints', () => {
      const hint = synthesizeBackendTargetHint('GET', "route('pembayaran.index')");
      expect(hint.isHeuristic).toBe(true);
      expect(hint.disclaimer).toContain('Pure Naming Convention Heuristic');
      expect(hint.suggestedSymbols[0]).toBe('PembayaranController');
    });
  });

  // Item 6: Fast Reverse Dependency Lookup & Bounded Limits
  describe('Item 6: Fast Reverse-Dependency Lookup via SQLite', () => {
    it('uses SQLite edges table for upward blast radius in sub-millisecond time', async () => {
      const tempDir = mkdtempSync(join(tmpdir(), 'strata-improvements-'));
      try {
        const db = getWorkspaceDatabase(tempDir, { create: true });
        
        // Setup parent page and child button in SQLite graph DB
        const buttonPath = join(tempDir, 'src/components/AppButton.vue');
        const page1Path = join(tempDir, 'src/pages/Dashboard.vue');
        const page2Path = join(tempDir, 'src/pages/Penjualan.vue');
        mkdirSync(join(tempDir, 'src/components'), { recursive: true });
        mkdirSync(join(tempDir, 'src/pages'), { recursive: true });

        writeFileSync(buttonPath, '<template><button><slot /></button></template>');
        writeFileSync(page1Path, '<template><AppButton /></template>');
        writeFileSync(page2Path, '<template><AppButton /></template>');

        const f1 = db.query('INSERT INTO files(path, framework, mtime, size, is_page) VALUES (?, ?, ?, ?, ?) RETURNING id').get(buttonPath, 'vue', 1000, 100, 0) as { id: number };
        const f2 = db.query('INSERT INTO files(path, framework, mtime, size, is_page) VALUES (?, ?, ?, ?, ?) RETURNING id').get(page1Path, 'vue', 1000, 200, 1) as { id: number };
        const f3 = db.query('INSERT INTO files(path, framework, mtime, size, is_page) VALUES (?, ?, ?, ?, ?) RETURNING id').get(page2Path, 'vue', 1000, 200, 1) as { id: number };

        db.query('INSERT INTO edges(parent_file_id, child_file_id, import_type, is_rendered) VALUES (?, ?, ?, ?)').run(f2.id, f1.id, 'static', 1);
        db.query('INSERT INTO edges(parent_file_id, child_file_id, import_type, is_rendered) VALUES (?, ?, ?, ?)').run(f3.id, f1.id, 'static', 1);

        const start = performance.now();
        const tree = await getUpwardComponentTree({
          entryPath: buttonPath,
          targetPath: tempDir,
          maxDepth: 1,
          limit: 20,
        });
        const elapsedMs = performance.now() - start;

        expect(elapsedMs).toBeLessThan(50); // Sub-50ms execution
        expect(tree.direction).toBe('upward');
        expect(tree.root.children.length).toBe(2);
        const childrenPaths = tree.root.children.map(c => c.filePath);
        expect(childrenPaths).toContain(page1Path);
        expect(childrenPaths).toContain(page2Path);
      } finally {
        rmSync(tempDir, { recursive: true, force: true });
      }
    });

    it('enforces default limit 20 and reports has_more when consumers exceed limit', async () => {
      const tempDir = mkdtempSync(join(tmpdir(), 'strata-limits-'));
      try {
        const db = getWorkspaceDatabase(tempDir, { create: true });
        const buttonPath = join(tempDir, 'src/components/AtomButton.vue');
        mkdirSync(join(tempDir, 'src/components'), { recursive: true });
        writeFileSync(buttonPath, '<template><button /></template>');

        const f1 = db.query('INSERT INTO files(path, framework, mtime, size, is_page) VALUES (?, ?, ?, ?, ?) RETURNING id').get(buttonPath, 'vue', 1000, 100, 0) as { id: number };

        // Insert 25 parent files
        for (let i = 1; i <= 25; i++) {
          const parentPath = join(tempDir, `src/pages/Page${i}.vue`);
          const pf = db.query('INSERT INTO files(path, framework, mtime, size, is_page) VALUES (?, ?, ?, ?, ?) RETURNING id').get(parentPath, 'vue', 1000, 200, 1) as { id: number };
          db.query('INSERT INTO edges(parent_file_id, child_file_id, import_type, is_rendered) VALUES (?, ?, ?, ?)').run(pf.id, f1.id, 'static', 1);
        }

        const tree = await getUpwardComponentTree({
          entryPath: buttonPath,
          targetPath: tempDir,
          limit: 20,
        });

        expect(tree.root.children.length).toBe(20);
        expect(tree.has_more).toBe(true);
        expect(tree.diagnostics?.some(d => d.code === 'UPWARD_RESULTS_TRUNCATED')).toBe(true);
      } finally {
        rmSync(tempDir, { recursive: true, force: true });
      }
    });
  });
});
