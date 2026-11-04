import { describe, expect, it } from 'bun:test';
import { join } from 'node:path';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { syncWorkspace } from '../../src/engine/storage/delta-sync';
import { getWorkspaceDatabase, closeWorkspaceDatabase } from '../../src/engine/storage/schema';

describe('Incremental Impact Set & Minimal Re-parse Optimization (TODO-07 / R-04 & R-09)', () => {
  it('minimizes parserInvocations to impacted reverse dependency chain, skipping unrelated components', async () => {
    const root = mkdtempSync(join(tmpdir(), 'strata-impact-test-'));
    try {
      mkdirSync(join(root, 'src'));
      mkdirSync(join(root, 'src/components'));

      // 4 components: App -> Dashboard -> StatCard; App -> Sidebar
      const appCode = `<script setup>
import Dashboard from './components/Dashboard.vue';
import Sidebar from './components/Sidebar.vue';
</script>
<template>
  <div>
    <Sidebar />
    <Dashboard />
  </div>
</template>`;

      const dashboardCode = `<script setup>
import StatCard from './StatCard.vue';
</script>
<template>
  <div class="dashboard">
    <StatCard title="Sales" />
  </div>
</template>`;

      const statCardCode = `<script setup>
defineProps<{ title: string }>();
</script>
<template>
  <div class="card">
    <h3>{{ title }}</h3>
  </div>
</template>`;

      const sidebarCode = `<template>
  <aside>Sidebar Nav</aside>
</template>`;

      writeFileSync(join(root, 'src/App.vue'), appCode);
      writeFileSync(join(root, 'src/components/Dashboard.vue'), dashboardCode);
      writeFileSync(join(root, 'src/components/StatCard.vue'), statCardCode);
      writeFileSync(join(root, 'src/components/Sidebar.vue'), sidebarCode);

      getWorkspaceDatabase(root, { create: true });

      // 1. Initial cold sync: all 4 files are parsed
      const initialSync = await syncWorkspace(root);
      expect(initialSync.total).toBe(4);
      expect(initialSync.parserInvocations).toBe(4);
      expect(initialSync.cacheHit).toBe(false);

      // 2. Warm sync without changes: 0 parser invocations, cacheHit true
      const warmSync = await syncWorkspace(root);
      expect(warmSync.cacheHit).toBe(true);
      expect(warmSync.parserInvocations).toBe(0);

      // 3. Mutate only Sidebar.vue (isolated from Dashboard and StatCard)
      writeFileSync(join(root, 'src/components/Sidebar.vue'), '<template><aside>Updated Sidebar Nav</aside></template>');
      const sidebarSync = await syncWorkspace(root);
      expect(sidebarSync.cacheHit).toBe(false);
      expect(sidebarSync.modified).toBe(1);
      // Impact set: Sidebar.vue (direct mutation) + App.vue (parent caller) = 2 files
      // Dashboard.vue and StatCard.vue are NOT impacted and MUST NOT be re-parsed!
      expect(sidebarSync.parserInvocations).toBe(2);

      // 4. Mutate only StatCard.vue
      writeFileSync(join(root, 'src/components/StatCard.vue'), statCardCode.replace('<h3>', '<h2>').replace('</h3>', '</h2>'));
      const statCardSync = await syncWorkspace(root);
      expect(statCardSync.modified).toBe(1);
      // Impact set: StatCard.vue (direct) + Dashboard.vue (parent) + App.vue (grandparent) = 3 files
      // Sidebar.vue is NOT impacted and MUST NOT be re-parsed!
      expect(statCardSync.parserInvocations).toBe(3);

      // 5. Verify database integrity: all 4 files still exist and edges are correct
      const db = getWorkspaceDatabase(root);
      const fileCount = (db.query('SELECT count(*) as count FROM files').get() as { count: number }).count;
      expect(fileCount).toBe(4);

      const edges = db.query(`
        SELECT p.path AS parent, c.path AS child
        FROM edges e
        JOIN files p ON p.id = e.parent_file_id
        JOIN files c ON c.id = e.child_file_id
        ORDER BY p.path, c.path
      `).all() as Array<{ parent: string; child: string }>;
      expect(edges.length).toBe(3);
    } finally {
      closeWorkspaceDatabase(root);
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('triggers full re-parse when compiler configuration or cache version is invalidated', async () => {
    const root = mkdtempSync(join(tmpdir(), 'strata-config-reset-'));
    try {
      writeFileSync(join(root, 'tsconfig.json'), JSON.stringify({
        compilerOptions: { paths: { '@/*': ['src/*'] } }
      }));
      mkdirSync(join(root, 'src'));
      writeFileSync(join(root, 'src/ComponentA.vue'), '<template><div>A</div></template>');
      writeFileSync(join(root, 'src/ComponentB.vue'), '<template><div>B</div></template>');

      getWorkspaceDatabase(root, { create: true });

      const firstSync = await syncWorkspace(root);
      expect(firstSync.parserInvocations).toBe(2);

      // Change tsconfig.json -> must trigger reset and re-parse all files
      writeFileSync(join(root, 'tsconfig.json'), JSON.stringify({
        compilerOptions: { paths: { '@/*': ['src/different/*'] } }
      }));

      const resetSync = await syncWorkspace(root);
      expect(resetSync.cacheHit).toBe(false);
      expect(resetSync.parserInvocations).toBe(2);
    } finally {
      closeWorkspaceDatabase(root);
      rmSync(root, { recursive: true, force: true });
    }
  });
});
