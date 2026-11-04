import { expect, test } from 'bun:test';
import { withRetrievalEvidence } from '../../src/tools/retrieval-response';
import { withDecisionResponse } from '../../src/tools/decision-response';

test('six tools expose explicit summaries with counts and full-detail recovery while preserving risks and failed checks', async () => {
  const records = Array.from({ length: 30 }, (_, id) => ({ file: `file-${id}.vue`, snippet: 'large body '.repeat(1000), line: id + 1 }));
  const samples: Record<string, { args: Record<string, unknown>; payload: Record<string, unknown> }> = {
    find_code: { args: { path: '/fixture', pattern: 'x' }, payload: { matches: records } },
    inspect_component: { args: { path: '/fixture/Child.vue' }, payload: { props: [{ name: 'title', type: 'string', required: true }] } },
    get_component_tree: { args: { path: '/fixture/Child.vue' }, payload: { root: { children: records } } },
    trace_state: { args: { path: '/fixture', identifier: 'useStore' }, payload: { consumers: records } },
    audit_frontend: { args: { path: '/fixture', target: 'routes' }, payload: { routes: records } },
    generate_patch_plan: { args: { path: '/fixture/Child.vue', refactor_type: 'rename_prop' }, payload: { patches: records } },
  };
  for (const [name, { args, payload }] of Object.entries(samples)) {
    const diagnostic = { code: 'UNRESOLVED', reason: 'Keep this risk visible.' };
    const tool = withRetrievalEvidence({ name, description: '', inputSchema: { type: 'object' }, handler: async () => ({
      content: [{ type: 'text', text: JSON.stringify(payload) }], structuredContent: { ...payload, diagnostics: [diagnostic] },
    }) });
    const full = await tool.handler({ ...args, response_detail: 'full' });
    const summary = await tool.handler({ ...args, response_detail: 'summary', max_bytes: 16000 });
    expect(summary.isError).not.toBe(true);
    const data = summary.structuredContent as any;
    expect(data.resultSummary.tool).toBe(name);
    expect(data.diagnostics).toEqual([diagnostic]);
    expect(data.retrieval.omissions.some((item: any) => item.code === 'SUMMARY_DETAIL_OMITTED')).toBe(true);
    expect(data.decision.next[0]).toMatchObject({ action: 'request-detail', tool: name, arguments: { response_detail: 'full' }, argumentMode: 'merge-original' });
    if (name !== 'inspect_component') {
      expect(data.decision.selection.count).toBe(30);
      expect(JSON.stringify(summary).length).toBeLessThan(JSON.stringify(full).length);
      expect(summary.content[0]!.text).not.toContain('large body');
    }
  }
});

test('summary rejects unsupported exact-source/continuation combinations before analysis', async () => {
  let calls = 0;
  const tool = withRetrievalEvidence({ name: 'inspect_component', description: '', inputSchema: { type: 'object' }, handler: async () => { calls++; return { content: [] }; } });
  for (const args of [{ response_detail: 'bad' }, { response_detail: 'summary', view: 'source' }, { response_detail: 'summary', source_range: { start_line: 1, end_line: 2 } }, { response_detail: 'summary', continuation_token: 'x' }])
    expect((await tool.handler(args)).isError).toBe(true);
  expect(calls).toBe(0);
});

test('mapped source recovery advances to a real source_ref and preserves workspace', () => {
  const ref = { sha256: 'hash', startOffset: 2, endOffset: 8 };
  const result = withDecisionResponse({ content: [], structuredContent: { snapshot: { file: '/fixture/Child.vue' }, regions: [{ ref }] } },
    'inspect_component', { path: 'Child.vue', project_root: '/fixture', view: 'map' });
  expect((result.structuredContent?.decision as any).next[0].arguments).toEqual({ path: '/fixture/Child.vue', project_root: '/fixture', view: 'source', source_ref: ref });
});

test('summary preserves nested warnings beyond its preview and contract diagnostics', async () => {
  const tool = withRetrievalEvidence({ name: 'get_component_tree', description: '', inputSchema: { type: 'object' }, handler: async () => ({
    content: [], structuredContent: { root: { children: [
      { filePath: 'A.vue' }, { filePath: 'B.vue' }, { filePath: 'C.vue' },
      { filePath: 'Unknown.vue', children: [{ filePath: 'Deep.vue', warning: 'Unresolved runtime target' }] },
    ] }, propsDrilling: [{ prop: 'title', recommendation: 'Review coupling' }] },
  }) });
  const result = await tool.handler({ path: '/fixture/App.vue', response_detail: 'summary' });
  const data = result.structuredContent as any;
  expect(data.resultSummary.preview.length).toBe(3);
  expect(data.safetyDetails).toContainEqual({ path: 'root.children[3].children[0].warning', file: 'Deep.vue', value: 'Unresolved runtime target' });
  expect(data.safetyDetails.some((item: any) => item.path === 'propsDrilling')).toBe(true);
});

test('Workstream 2: summary mode projects rich compact contract with stateDependencies, apiCalls, and formCount', async () => {
  const payload = {
    props: [{ name: 'userId', type: 'string', required: true }],
    framework: 'vue',
    stateDependencies: {
      stores: ['useUserStore'],
      contexts: ['ThemeContext'],
      composables: ['useAuth'],
    },
    boundaryContracts: [
      { boundaryType: 'fetch', method: 'GET', targetEndpoint: '/api/v1/profile' },
      { boundaryType: 'axios', method: 'POST', targetEndpoint: '/api/v1/update' },
    ],
    formContracts: [
      { binding: 'profileForm', isMultipart: false, fields: [] },
    ],
  };

  const tool = withRetrievalEvidence({
    name: 'inspect_component',
    description: '',
    inputSchema: { type: 'object' },
    handler: async () => ({
      content: [{ type: 'text', text: JSON.stringify(payload) }],
      structuredContent: payload,
    }),
  });

  const result = await tool.handler({ path: '/fixture/UserProfile.vue', response_detail: 'summary' });
  expect(result.isError).not.toBe(true);
  const contract = (result.structuredContent as any)?.resultSummary?.contract;
  expect(contract).toBeDefined();
  expect(contract.propCount).toBe(1);
  expect(contract.stateDependencies).toEqual(['useUserStore', 'ThemeContext', 'useAuth']);
  expect(contract.apiCalls).toEqual([
    { method: 'GET', endpoint: '/api/v1/profile' },
    { method: 'POST', endpoint: '/api/v1/update' },
  ]);
  expect(contract.formCount).toBe(1);
});
