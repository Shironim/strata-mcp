import { describe, expect, it } from 'bun:test';
import {
  applyContextBudget,
  applyResponseBudget,
  decodeAndVerifyContinuationToken,
  encodeContinuationToken,
  MINIMUM_RESPONSE_BUDGET_BYTES,
  sortDeterministically,
} from '../../src/engine/context-budget';
import type { ContinuationTokenPayload } from '../../src/types';
import { findCodeTool } from '../../src/tools/find-code';
import { inspectComponentTool } from '../../src/tools/inspect-component';
import { componentTreeTool } from '../../src/tools/component-tree';
import { auditFrontendTool } from '../../src/tools/audit-frontend';

describe('Context Budgeting & Continuation Tokens (R-07 / R-08 / G-06)', () => {
  const dummyItems = Array.from({ length: 50 }, (_, i) => ({
    id: i + 1,
    name: `Item_${i + 1}`,
    content: `Some repetitive content payload for item number ${i + 1} with sufficient length.`,
  }));

  const sampleTokenContext = {
    tool: 'find_code',
    queryId: 'query-hash-12345',
    sourceHash: 'source-hash-abcdef',
    indexGeneration: 'gen-42',
    configFingerprint: 'cfg-fingerprint-999',
    engineRevision: '1.0.0',
  };

  it('enforces minimum budget threshold', () => {
    expect(() => {
      applyContextBudget(dummyItems, { maxBytes: 256 });
    }).toThrow('BUDGET_TOO_SMALL');

    expect(MINIMUM_RESPONSE_BUDGET_BYTES).toBe(512);
  });

  it('truncates results when maxBytes budget is exceeded and provides continuation token', () => {
    const result = applyContextBudget(dummyItems, {
      maxBytes: 1024,
      tokenContext: sampleTokenContext,
    });

    expect(result.items.length).toBeLessThan(dummyItems.length);
    expect(result.hasMore).toBe(true);
    expect(result.isTruncated).toBe(true);
    expect(result.continuationToken).toBeDefined();
    expect(result.offset).toBe(0);
    expect(result.nextOffset).toBe(result.items.length);
  });

  it('paginates deterministically end-to-end across multiple pages without loss or duplicate', () => {
    const allCollected: typeof dummyItems = [];
    let currentToken: string | undefined = undefined;
    let pageCount = 0;

    while (true) {
      pageCount++;
      const page = applyContextBudget(dummyItems, {
        maxItems: 12,
        continuationToken: currentToken,
        tokenContext: sampleTokenContext,
      });

      allCollected.push(...page.items);
      if (!page.hasMore) break;
      currentToken = page.continuationToken;
      expect(currentToken).toBeDefined();
    }

    expect(allCollected.length).toBe(dummyItems.length);
    expect(allCollected.map(i => i.id)).toEqual(dummyItems.map(i => i.id));
    expect(pageCount).toBe(5); // 12 * 4 + 2 = 50
  });

  it('sorts items deterministically regardless of SQLite or array insertion order', () => {
    const unorderedNodes = [
      { depth: 2, isPage: false, path: 'src/components/Zebra.vue', sqliteId: 99 },
      { depth: 1, isPage: false, path: 'src/components/Beta.vue', sqliteId: 105 },
      { depth: 1, isPage: true, path: 'src/pages/AlphaPage.vue', sqliteId: 12 },
      { depth: 2, isPage: false, path: 'src/components/Apple.vue', sqliteId: 1 },
      { depth: 1, isPage: false, path: 'src/components/Alpha.vue', sqliteId: 88 },
    ];

    const sorted = sortDeterministically(unorderedNodes);

    // Depth 1 first; pages before non-pages; alphabetical path tie-breaking
    expect(sorted.map(s => s.path)).toEqual([
      'src/pages/AlphaPage.vue',
      'src/components/Alpha.vue',
      'src/components/Beta.vue',
      'src/components/Apple.vue',
      'src/components/Zebra.vue',
    ]);
  });

  it('sorts source regions deterministically by startOffset and endOffset', () => {
    const regions = [
      { name: 'template', range: { startOffset: 200, endOffset: 300 } },
      { name: 'style', range: { startOffset: 400, endOffset: 500 } },
      { name: 'script', range: { startOffset: 0, endOffset: 150 } },
    ];
    const sorted = sortDeterministically(regions);
    expect(sorted.map(r => r.name)).toEqual(['script', 'template', 'style']);
  });

  it('rejects stale continuation token when source file changed', () => {
    const tokenPayload: ContinuationTokenPayload = {
      version: 1,
      tool: 'inspect_component',
      queryId: 'q-1',
      sourceHash: 'hash-initial',
      engineRevision: '1.0.0',
      offset: 10,
      totalItems: 50,
      issuedAt: Date.now(),
    };
    const token = encodeContinuationToken(tokenPayload);

    // Verify with mutated sourceHash
    const check = decodeAndVerifyContinuationToken(token, {
      tool: 'inspect_component',
      queryId: 'q-1',
      sourceHash: 'hash-mutated-on-disk',
    });

    expect(check.valid).toBe(false);
    expect(check.error).toContain('STALE_CONTINUATION_TOKEN: source file changed');
  });

  it('rejects stale continuation token when database generation changed', () => {
    const tokenPayload: ContinuationTokenPayload = {
      version: 1,
      tool: 'get_component_tree',
      queryId: 'q-2',
      indexGeneration: 'gen-1',
      engineRevision: '1.0.0',
      offset: 5,
      totalItems: 20,
      issuedAt: Date.now(),
    };
    const token = encodeContinuationToken(tokenPayload);

    const check = decodeAndVerifyContinuationToken(token, {
      tool: 'get_component_tree',
      queryId: 'q-2',
      indexGeneration: 'gen-2',
    });

    expect(check.valid).toBe(false);
    expect(check.error).toContain('STALE_CONTINUATION_TOKEN: database index generation changed');
  });

  it('rejects stale continuation token when configuration fingerprint changed', () => {
    const tokenPayload: ContinuationTokenPayload = {
      version: 1,
      tool: 'find_code',
      queryId: 'q-3',
      configFingerprint: 'cfg-v1',
      engineRevision: '1.0.0',
      offset: 5,
      totalItems: 20,
      issuedAt: Date.now(),
    };
    const token = encodeContinuationToken(tokenPayload);

    const check = decodeAndVerifyContinuationToken(token, {
      tool: 'find_code',
      queryId: 'q-3',
      configFingerprint: 'cfg-v2',
    });

    expect(check.valid).toBe(false);
    expect(check.error).toContain('STALE_CONTINUATION_TOKEN: configuration fingerprint changed');
  });

  it('rejects stale continuation token when engine revision changed', () => {
    const tokenPayload: ContinuationTokenPayload = {
      version: 1,
      tool: 'find_code',
      queryId: 'q-4',
      engineRevision: '1.0.0',
      offset: 5,
      totalItems: 20,
      issuedAt: Date.now(),
    };
    const token = encodeContinuationToken(tokenPayload);

    const check = decodeAndVerifyContinuationToken(token, {
      tool: 'find_code',
      queryId: 'q-4',
      engineRevision: '1.1.0-updated',
    });

    expect(check.valid).toBe(false);
    expect(check.error).toContain('STALE_CONTINUATION_TOKEN: engine revision changed');
  });

  it('rejects token when queryId or tool mismatches or token is corrupted', () => {
    const tokenPayload: ContinuationTokenPayload = {
      version: 1,
      tool: 'find_code',
      queryId: 'query-A',
      engineRevision: '1.0.0',
      offset: 10,
      totalItems: 50,
      issuedAt: Date.now(),
    };
    const token = encodeContinuationToken(tokenPayload);

    // Mismatched tool
    const toolCheck = decodeAndVerifyContinuationToken(token, {
      tool: 'inspect_component',
      queryId: 'query-A',
    });
    expect(toolCheck.valid).toBe(false);
    expect(toolCheck.error).toContain('INVALID_CONTINUATION_TOKEN: token tool');

    // Mismatched queryId
    const queryCheck = decodeAndVerifyContinuationToken(token, {
      tool: 'find_code',
      queryId: 'query-B',
    });
    expect(queryCheck.valid).toBe(false);
    expect(queryCheck.error).toContain('INVALID_CONTINUATION_TOKEN: query parameters changed');

    // Malformed token
    const malformedCheck = decodeAndVerifyContinuationToken('not-valid-base64-json!!!', {
      tool: 'find_code',
      queryId: 'query-A',
    });
    expect(malformedCheck.valid).toBe(false);
    expect(malformedCheck.error).toContain('INVALID_CONTINUATION_TOKEN: token is malformed');
  });

  it('enforces budget through findCodeTool handler and supports continuation tokens', async () => {
    // 1. Budget too small (<512) rejected early
    const smallResp = await findCodeTool.handler({
      code: 'const a = 1;\nconst b = 2;',
      pattern: 'const $A = $B;',
      max_bytes: 256,
    });
    expect(smallResp.isError).toBe(true);
    expect(smallResp.content[0].text).toContain('BUDGET_TOO_SMALL');

    // 2. Adequate budget on multi-match snippet
    const repeatedCode = Array.from({ length: 100 }, (_, i) => `const val_${i} = ref(${i});`).join('\n');
    const firstPage = await findCodeTool.handler({
      code: repeatedCode,
      pattern: 'const $A = ref($B);',
      format: 'json',
      max_bytes: 12000,
    });

    expect(firstPage.isError).toBeFalsy();
    expect(Buffer.byteLength(JSON.stringify(firstPage))).toBeLessThanOrEqual(12000);
    const data = firstPage.structuredContent;
    expect(data.is_truncated).toBe(true);
    expect(data.continuationToken).toBeDefined();
    expect(data.matches.length).toBeLessThan(100);
    expect(data.retrieval?.budget?.isTruncated).toBe(true);
    expect(data.retrieval?.omissions.some((o: any) => o.code === 'CONTEXT_BUDGET_EXCEEDED')).toBe(true);

    // 3. Paginate with continuation token
    const secondPage = await findCodeTool.handler({
      code: repeatedCode,
      pattern: 'const $A = ref($B);',
      continuation_token: data.continuationToken,
      format: 'json',
      max_bytes: 12000,
    });

    expect(secondPage.isError).toBeFalsy();
    expect(Buffer.byteLength(JSON.stringify(secondPage))).toBeLessThanOrEqual(12000);
    const secondData = secondPage.structuredContent;
    expect(secondData.offset).toBe(data.matches.length);

    // 4. Reject if query pattern changed
    const tamperedQuery = await findCodeTool.handler({
      code: repeatedCode,
      pattern: 'const $OTHER = ref($B);',
      continuation_token: data.continuationToken,
      format: 'json',
    });
    expect(tamperedQuery.isError).toBe(true);
    expect(tamperedQuery.content[0].text).toContain('INVALID_CONTINUATION_TOKEN: query parameters changed');
  });

  it('enforces budget through inspectComponentTool and rejects stale token on file mutation', async () => {
    const fixturePath = 'tests/fixtures/PageOne.vue';

    // 1. Budget too small
    const smallResp = await inspectComponentTool.handler({
      path: fixturePath,
      view: 'map',
      max_bytes: 300,
    });
    expect(smallResp.isError).toBe(true);
    expect(smallResp.content[0].text).toContain('BUDGET_TOO_SMALL');

    // 2. Budgeted map view
    const budgetedResp = await inspectComponentTool.handler({
      path: fixturePath,
      view: 'map',
      max_bytes: 24000,
      format: 'json',
    });

    expect(budgetedResp.isError).toBeFalsy();
    const data = budgetedResp.structuredContent;
    expect(data.regions).toBeDefined();
    expect(Buffer.byteLength(JSON.stringify(budgetedResp))).toBeLessThanOrEqual(24000);
    expect(data.retrieval.source.sha256).toBeDefined();

    // 3. Fake mutated token to simulate external disk modification
    const payload: ContinuationTokenPayload = {
      version: 1,
      tool: 'inspect_component',
      queryId: data.retrieval.queryId,
      sourceHash: 'tampered-hash-does-not-match-disk',
      engineRevision: data.retrieval.engineRevision,
      offset: 5,
      totalItems: 20,
      issuedAt: Date.now(),
    };
    const staleToken = encodeContinuationToken(payload);

    const staleResp = await inspectComponentTool.handler({
      path: fixturePath,
      view: 'map',
      continuation_token: staleToken,
      format: 'json',
    });

    expect(staleResp.isError).toBe(true);
    expect(staleResp.content[0].text).toContain('STALE_CONTINUATION_TOKEN: source file changed');
  });

  it('enforces budget through componentTreeTool and rejects stale token on index change', async () => {
    const { mkdtemp, copyFile, writeFile, rm } = await import('node:fs/promises');
    const { join, resolve } = await import('node:path');
    const { syncWorkspace } = await import('../../src/engine/storage/delta-sync');
    const { getWorkspaceDatabase, closeWorkspaceDatabase } = await import('../../src/engine/storage/schema');
    const fixtureRoot = await mkdtemp('/tmp/strata-budget-tree-');
    const leaf = join(fixtureRoot, 'OldButton.vue');
    await copyFile(resolve(import.meta.dir, '../fixtures/OldButton.vue'), leaf);
    await writeFile(join(fixtureRoot, 'package.json'), '{"dependencies":{"vue":"3"}}');
    await writeFile(join(fixtureRoot, 'Parent.vue'), '<script setup>import OldButton from "./OldButton.vue";</script><template><OldButton /></template>');
    try {
      getWorkspaceDatabase(fixtureRoot, { create: true, enableWatcher: false });
      await syncWorkspace(fixtureRoot);

      const resp = await componentTreeTool.handler({
        path: leaf,
        target_path: fixtureRoot,
        direction: 'upward',
        format: 'json',
        max_bytes: 64000,
      });

      expect(resp.isError).toBeFalsy();
      expect(Buffer.byteLength(JSON.stringify(resp))).toBeLessThanOrEqual(64000);
      const data = resp.structuredContent;
      expect(data.root.children).toBeDefined();

      // Verify rejection on mutated index generation
      const payload: ContinuationTokenPayload = {
        version: 1,
        tool: 'get_component_tree',
        queryId: data.retrieval.queryId,
        indexGeneration: 'mutated-generation-999',
        engineRevision: data.retrieval.engineRevision,
        offset: 1,
        totalItems: 5,
        issuedAt: Date.now(),
      };
      const staleToken = encodeContinuationToken(payload);

      const staleResp = await componentTreeTool.handler({
        path: leaf,
        target_path: fixtureRoot,
        direction: 'upward',
        continuation_token: staleToken,
        format: 'json',
      });

      expect(staleResp.isError).toBe(true);
      expect(staleResp.content[0].text).toContain('STALE_CONTINUATION_TOKEN: database index generation changed');
    } finally {
      closeWorkspaceDatabase(fixtureRoot);
      await rm(fixtureRoot, { recursive: true, force: true });
    }
  });

  it('enforces budget on auditFrontendTool routes and diagnostics', async () => {
    // 1. Minimum budget validation
    const smallResp = await auditFrontendTool.handler({
      path: 'tests/fixtures',
      target: 'routes',
      max_bytes: 256,
    });
    expect(smallResp.isError).toBe(true);
    expect(smallResp.content[0].text).toContain('BUDGET_TOO_SMALL');

    // 2. Budgeted routes
    const resp = await auditFrontendTool.handler({
      path: 'tests/fixtures',
      target: 'routes',
      format: 'json',
      max_bytes: 64000,
    });

    expect(resp.isError).toBeFalsy();
    expect(Buffer.byteLength(JSON.stringify(resp))).toBeLessThanOrEqual(64000);
    expect(resp.structuredContent.routes).toBeDefined();
    expect(resp.structuredContent.retrieval).toBeDefined();
  });
});
