import { describe, expect, it } from 'bun:test';
import { join } from 'node:path';
import { promises as fs } from 'node:fs';
import { findSimilarTemplates, formatSimilarTemplatesAsText } from '../../src/engine/template-similarity';

describe('Template Similarity Engine Hardening', () => {
  it('should recommend .tsx extension for React clusters in a React project', async () => {
    // Create a temporary mock directory simulating a Next.js/React project
    const tempDir = join(import.meta.dir, '../fixtures/mock-react-cluster');
    await fs.mkdir(tempDir, { recursive: true });

    const fileA = join(tempDir, 'UserListCard.tsx');
    const fileB = join(tempDir, 'ProductListCard.tsx');

    const contentA = `
      export function UserListCard() {
        return (
          <div className="card">
            <CardHeader />
            <DataTable />
            <PaginationControls />
          </div>
        );
      }
    `;

    const contentB = `
      export function ProductListCard() {
        return (
          <div className="card">
            <CardHeader />
            <DataTable />
            <PaginationControls />
          </div>
        );
      }
    `;

    await fs.writeFile(fileA, contentA);
    await fs.writeFile(fileB, contentB);

    try {
      const result = await findSimilarTemplates({
        targetPath: tempDir,
        threshold: 0.8,
      });

      expect(result.clusters.length).toBeGreaterThanOrEqual(1);
      const cluster = result.clusters[0];
      // Recommendation must end with .tsx and not .vue!
      expect(cluster.recommendation).toContain('.tsx');
      expect(cluster.recommendation).not.toContain('.vue');

      const text = formatSimilarTemplatesAsText(result);
      expect(text).toContain('.tsx');
      expect(text).not.toContain('.vue');
    } finally {
      await fs.rm(tempDir, { recursive: true, force: true });
    }
  });

  it('should recommend .vue extension for Vue clusters in a Vue project', async () => {
    const tempDir = join(import.meta.dir, '../fixtures/mock-vue-cluster');
    await fs.mkdir(tempDir, { recursive: true });

    const fileA = join(tempDir, 'OrderOverviewCard.vue');
    const fileB = join(tempDir, 'InvoiceOverviewCard.vue');

    const contentA = `
      <template>
        <div class="card">
          <CardHeader />
          <DataTable />
          <PaginationControls />
        </div>
      </template>
    `;

    const contentB = `
      <template>
        <div class="card">
          <CardHeader />
          <DataTable />
          <PaginationControls />
        </div>
      </template>
    `;

    await fs.writeFile(fileA, contentA);
    await fs.writeFile(fileB, contentB);

    try {
      const result = await findSimilarTemplates({
        targetPath: tempDir,
        threshold: 0.8,
      });

      expect(result.clusters.length).toBeGreaterThanOrEqual(1);
      const cluster = result.clusters[0];
      expect(cluster.recommendation).toContain('.vue');
    } finally {
      await fs.rm(tempDir, { recursive: true, force: true });
    }
  });
});
