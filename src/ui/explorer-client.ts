/// <reference lib="dom" />
import {
  App,
  applyDocumentTheme,
  applyHostStyleVariables,
} from '@modelcontextprotocol/ext-apps';
import { z } from 'zod';

type AnyRecord = Record<string, any>;
type TabKind = 'overview' | 'routes' | 'tree';

interface QueryEnvelope<T = any> {
  scope: string;
  verification: string;
  data: T;
  pagination?: { total: number; offset: number; limit: number; hasMore: boolean; nextCursor?: string };
  omissions: Array<{ code: string; filePath: string; line: number; column: number; reason: string; sourceRef?: string }>;
  diagnostics: Array<{ code: string; message: string }>;
}

interface SlicePreviewState {
  filePath: string;
  startLine: number;
  endLine: number;
  totalLines: number;
  content: string;
}

interface WorkspaceViewState {
  overview: QueryEnvelope<any> | null;
  routes: QueryEnvelope<any> | null;
  health: QueryEnvelope<any> | null;
  selectedComponentPath: string;
  treeData: QueryEnvelope<any> | null;
  impactData: QueryEnvelope<any> | null;
  inspectData: QueryEnvelope<any> | null;
  slicePreview: SlicePreviewState | null;
  searchQuery: string;
  searchResults: Array<{ name: string; kind: string; filePath: string; relPath: string; line: number }>;
  routeFilter: string;
  selectedHealth: Set<string>;
  selectedRoutes: Set<string>;
  selectedImpact: Set<string>;
}

const DEFAULT_WORKSPACE_KEY = '__default__';
const ToggleAuxPaneResultSchema = z.object({ isError: z.boolean().optional() }).passthrough();

const TAB_PRESETS: Record<TabKind, ReadonlyArray<{ label: string; prompt: string }>> = {
  overview: [
    { label: 'Explain architecture', prompt: 'Explain the frontend architecture, packages, and frameworks in this workspace.' },
    { label: 'Triage unused components', prompt: 'Inspect these unused component candidates and verify if any are dynamically or globally registered before removal.' },
  ],
  routes: [
    { label: 'Audit route structure', prompt: 'Audit these routes, layouts, and URL hierarchy for consistency or missing guards.' },
    { label: 'Trace data & layouts', prompt: 'Explain how these selected routes load data and compose layouts.' },
  ],
  tree: [
    { label: 'Plan safe refactor', prompt: 'Create a safe refactoring plan for this component based on its contract, component tree, and impact sites.' },
    { label: 'Verify omissions & boundaries', prompt: 'Verify all DYNAMIC_SPREAD omissions and outbound HTTP boundaries for this component.' },
  ],
};

const DEFAULT_ASK_PROMPT: Record<TabKind, string> = {
  overview: 'Analyze this Strata workspace overview and health diagnostics:',
  routes: 'Analyze these Strata frontend routes:',
  tree: 'Analyze this Strata component tree, contract, and impact:',
};

const app = new App({ name: 'Strata Explorer', version: '0.11.0' }, {});

let currentTab: TabKind = 'overview';
let activeWorkspace: string | undefined;
let pendingWorkspaceRoot: string | undefined;
const knownWorkspaces: string[] = [];
const workspaceStates = new Map<string, WorkspaceViewState>();
let promptDraft = '';
let lastError: string | null = null;
let statusMsg = '';
let loading = false;

function esc(value: unknown): string {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function getWorkspaceKey(root?: string): string {
  const trimmed = root?.trim();
  return trimmed || DEFAULT_WORKSPACE_KEY;
}

function createEmptyWorkspaceState(): WorkspaceViewState {
  return {
    overview: null,
    routes: null,
    health: null,
    selectedComponentPath: '',
    treeData: null,
    impactData: null,
    inspectData: null,
    slicePreview: null,
    searchQuery: '',
    searchResults: [],
    routeFilter: '',
    selectedHealth: new Set<string>(),
    selectedRoutes: new Set<string>(),
    selectedImpact: new Set<string>(),
  };
}

function getWorkspaceState(root?: string): WorkspaceViewState {
  const key = getWorkspaceKey(root);
  let ws = workspaceStates.get(key);
  if (!ws) {
    ws = createEmptyWorkspaceState();
    workspaceStates.set(key, ws);
  }
  return ws;
}

function registerWorkspace(root?: string): void {
  const trimmed = root?.trim();
  if (!trimmed) return;
  if (!knownWorkspaces.includes(trimmed)) {
    knownWorkspaces.push(trimmed);
  }
  if (knownWorkspaces.length === 1 && workspaceStates.has(DEFAULT_WORKSPACE_KEY)) {
    const fallback = workspaceStates.get(DEFAULT_WORKSPACE_KEY)!;
    const target = getWorkspaceState(trimmed);
    target.overview ??= fallback.overview;
    target.routes ??= fallback.routes;
    target.health ??= fallback.health;
    workspaceStates.delete(DEFAULT_WORKSPACE_KEY);
  }
  activeWorkspace = trimmed;
}

function shortWorkspaceLabel(root: string): string {
  const parts = root.replace(/\\/g, '/').split('/').filter(Boolean);
  return parts[parts.length - 1] ?? root;
}

function toFileUri(filePath: string): string {
  const norm = filePath.replace(/\\/g, '/');
  return norm.startsWith('/') ? `file://${encodeURI(norm)}` : `file:///${encodeURI(norm)}`;
}

async function openFileInPane(filePath: string): Promise<void> {
  if (!filePath) return;
  const fullPath =
    filePath.startsWith('/') || !activeWorkspace
      ? filePath
      : `${activeWorkspace.replace(/\/+$/, '')}/${filePath.replace(/^\/+/, '')}`;
  try {
    const res = await app.request(
      {
        method: 'com.google.antigravity/toggle-aux-pane',
        params: { tabType: 'fileView', uri: toFileUri(fullPath) },
      },
      ToggleAuxPaneResultSchema
    );
    if (res?.isError) {
      setStatus(`Cannot open side pane for ${filePath} on this surface.`);
    }
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    if (msg.includes('-32601')) {
      setStatus(`Side pane navigation is unavailable in this host (${filePath}).`);
    } else {
      setStatus(`Open file failed: ${msg}`);
    }
  }
}

function setStatus(msg: string): void {
  statusMsg = msg;
  const el = document.getElementById('status-bar');
  if (el) el.textContent = loading ? 'Loading...' : msg;
}

function extractEnvelope(result: AnyRecord): QueryEnvelope<any> | null {
  if (result?.structuredContent && typeof result.structuredContent === 'object') {
    return result.structuredContent as QueryEnvelope<any>;
  }
  if (Array.isArray(result?.content)) {
    const textBlock = result.content.find((c: AnyRecord) => c?.type === 'text' && typeof c.text === 'string');
    if (textBlock) {
      try {
        return JSON.parse(textBlock.text) as QueryEnvelope<any>;
      } catch {
        return null;
      }
    }
  }
  return null;
}

async function callStrataTool(
  name: string,
  args: Record<string, unknown>,
  targetWorkspace = activeWorkspace
): Promise<QueryEnvelope<any> | null> {
  loading = true;
  lastError = null;
  render();
  try {
    const res = await app.callServerTool({
      name,
      arguments: {
        ...args,
        ...(targetWorkspace ? { root: targetWorkspace } : {}),
        format: 'json',
        max_bytes: 131072,
      },
    });
    if (res.isError) {
      const errText = (res.content?.[0] as { text?: string } | undefined)?.text ?? 'Tool call failed';
      lastError = errText;
      setStatus(errText);
      return null;
    }
    const env = extractEnvelope(res as AnyRecord);
    if (env?.scope) registerWorkspace(env.scope);
    return env;
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    lastError = msg;
    setStatus(msg);
    return null;
  } finally {
    loading = false;
    render();
  }
}

async function loadTab(tab: TabKind, targetWorkspace = activeWorkspace): Promise<void> {
  currentTab = tab;
  const ws = getWorkspaceState(targetWorkspace);
  if (tab === 'overview') {
    if (!ws.overview) {
      ws.overview = await callStrataTool('map_workspace', { view: 'overview' }, targetWorkspace);
    }
    if (!ws.health) {
      ws.health = await callStrataTool('map_workspace', { view: 'health', limit: 50 }, targetWorkspace);
    }
  } else if (tab === 'routes' && !ws.routes) {
    ws.routes = await callStrataTool('map_workspace', { view: 'routes', limit: 200 }, targetWorkspace);
  }
  render();
}

async function inspectComponent(filePath: string): Promise<void> {
  const ws = getWorkspaceState(activeWorkspace);
  ws.selectedComponentPath = filePath;
  ws.selectedImpact.clear();
  currentTab = 'tree';
  const [treeRes, impactRes, inspectRes] = await Promise.all([
    callStrataTool('query_graph', {
      query: 'component_tree',
      target: { file: filePath },
      direction: 'both',
      scope: { max_depth: 3 },
    }),
    callStrataTool('query_graph', {
      query: 'impact',
      target: { file: filePath },
      limit: 50,
    }),
    callStrataTool('inspect_file', {
      path: filePath,
      sections: ['contract', 'boundaries'],
    }),
  ]);
  ws.treeData = treeRes;
  ws.impactData = impactRes;
  ws.inspectData = inspectRes;
  render();
}

async function searchComponents(query: string): Promise<void> {
  const ws = getWorkspaceState(activeWorkspace);
  ws.searchQuery = query;
  if (!query.trim()) {
    ws.searchResults = [];
    render();
    return;
  }
  const res = await callStrataTool('search_code', {
    query: query.trim(),
    kind: 'symbol',
    symbol_kinds: ['component'],
    limit: 20,
  });
  ws.searchResults = res?.data?.matches ?? [];
  render();
}

async function previewSlice(filePath: string, line?: number): Promise<void> {
  if (!filePath) return;
  const start = line && line > 1 ? Math.max(1, line - 8) : 1;
  const end = start + 39;
  const res = await callStrataTool('read_slice', {
    path: filePath,
    lines: [start, end],
    max_lines: 60,
  });
  const d = res?.data;
  if (!d || typeof d.content !== 'string') return;
  const ws = getWorkspaceState(activeWorkspace);
  ws.slicePreview = {
    filePath: d.filePath ?? filePath,
    startLine: d.startLine ?? start,
    endLine: d.endLine ?? end,
    totalLines: d.totalLines ?? end,
    content: d.content,
  };
  render();
}

async function loadMoreRoutes(): Promise<void> {
  const ws = getWorkspaceState(activeWorkspace);
  const cursor = ws.routes?.pagination?.nextCursor;
  if (!cursor) return;
  const next = await callStrataTool('map_workspace', { view: 'routes', limit: 200, cursor });
  if (!next?.data?.routes) return;
  ws.routes = {
    ...next,
    data: {
      ...next.data,
      routes: [...(ws.routes?.data?.routes ?? []), ...next.data.routes],
    },
  };
  render();
}

async function loadMoreHealth(): Promise<void> {
  const ws = getWorkspaceState(activeWorkspace);
  const cursor = ws.health?.pagination?.nextCursor;
  if (!cursor) return;
  const next = await callStrataTool('map_workspace', { view: 'health', limit: 50, cursor });
  if (!next?.data?.health?.unusedComponents) return;
  ws.health = {
    ...next,
    data: {
      ...next.data,
      health: {
        ...next.data.health,
        unusedComponents: [
          ...(ws.health?.data?.health?.unusedComponents ?? []),
          ...next.data.health.unusedComponents,
        ],
      },
    },
  };
  render();
}

async function traceBackendWithSeptum(method: string, target: string, hint: string): Promise<void> {
  const caps = app.getHostCapabilities();
  const prompt = [
    `Trace the backend handler for frontend outbound HTTP call \`${method} ${target}\`${hint ? ` (backendTargetHint: \`${hint}\`)` : ''}.`,
    'Use Septum (`septum_slice` or `septum_symbol`) to trace the endpoint through controller, service, and repository.',
  ].join(' ');
  try {
    if (caps?.message) {
      await app.sendMessage({ role: 'user', content: [{ type: 'text', text: prompt }] });
      setStatus(`Sent backend trace handoff for ${method} ${target}.`);
    } else if (caps?.updateModelContext) {
      await app.updateModelContext({ content: [{ type: 'text', text: prompt }] });
      setStatus(`Attached backend trace handoff for ${method} ${target} to model context.`);
    }
  } catch (err: unknown) {
    setStatus(err instanceof Error ? err.message : String(err));
  }
}

function getSelectionCount(tab: TabKind, ws: WorkspaceViewState): number {
  if (tab === 'overview') return ws.selectedHealth.size;
  if (tab === 'routes') return ws.selectedRoutes.size;
  return ws.selectedImpact.size;
}

function clearSelection(tab: TabKind, ws: WorkspaceViewState): void {
  if (tab === 'overview') ws.selectedHealth.clear();
  else if (tab === 'routes') ws.selectedRoutes.clear();
  else ws.selectedImpact.clear();
}

function buildCompactContext(tab: TabKind, ws: WorkspaceViewState): string | null {
  const lines: string[] = [];
  if (activeWorkspace) lines.push(`Workspace: ${activeWorkspace}`);

  if (tab === 'overview') {
    const ov = ws.overview;
    const totals = ov?.data?.totals;
    if (totals) {
      lines.push(`# Strata Overview (verification=${ov?.verification ?? 'unknown'}, packages=${totals.packages}, files=${totals.files}, symbols=${totals.symbols}, routes=${totals.routes})`);
    }
    const pkgs: AnyRecord[] = ov?.data?.packages ?? [];
    if (pkgs.length > 0) {
      lines.push('\n## Packages');
      for (const p of pkgs.slice(0, 20)) {
        lines.push(`- ${p.packageKey} [${p.framework}] (${p.fileCount} files, ${p.symbolCount} symbols, ${p.routeCount} routes)`);
      }
    }
    const unused: AnyRecord[] = ws.health?.data?.health?.unusedComponents ?? [];
    const focused = ws.selectedHealth.size > 0
      ? unused.filter((c) => ws.selectedHealth.has(String(c.relPath)))
      : unused;
    if (focused.length > 0) {
      lines.push(`\n## Unused Component Candidates (${ws.selectedHealth.size > 0 ? `${focused.length} selected` : focused.length})`);
      for (const c of focused.slice(0, 25)) {
        lines.push(`- ${c.name} @ ${c.relPath}:${c.line}`);
      }
    }
    const diags = [...(ov?.diagnostics ?? []), ...(ws.health?.diagnostics ?? [])];
    if (diags.length > 0) {
      lines.push(`\n## Diagnostics (${diags.length})`);
      for (const d of diags.slice(0, 10)) {
        lines.push(`- [${d.code}] ${d.message}`);
      }
    }
    return lines.length > 1 || totals ? lines.join('\n') : null;
  }

  if (tab === 'routes' && ws.routes) {
    const allRoutes: AnyRecord[] = ws.routes.data?.routes ?? [];
    const focused = ws.selectedRoutes.size > 0
      ? allRoutes.filter((r) => ws.selectedRoutes.has(String(r.relPath)))
      : allRoutes;
    lines.push(`# Strata Routes (${ws.selectedRoutes.size > 0 ? `${focused.length} selected` : focused.length})`);
    for (const r of focused.slice(0, 30)) {
      lines.push(`- ${r.urlPath} [${r.routeType}] -> ${r.relPath}`);
    }
    return lines.join('\n');
  }

  if (tab === 'tree' && ws.selectedComponentPath) {
    lines.push(`# Strata Component Inspection: ${ws.selectedComponentPath}`);
    const contract = ws.inspectData?.data?.contract;
    if (contract) {
      const props = (contract.props ?? []).map((p: AnyRecord) => `${p.name}${p.required ? '' : '?'}: ${p.type}`).join(', ') || 'none';
      lines.push(`Props: ${props}`);
      if (contract.emits?.length) lines.push(`Emits: ${contract.emits.join(', ')}`);
      if (contract.slots?.length) lines.push(`Slots: ${contract.slots.join(', ')}`);
    }
    const outbound: AnyRecord[] = ws.inspectData?.data?.boundaries?.outboundHttp ?? [];
    if (outbound.length > 0) {
      lines.push(`\n## Outbound HTTP Boundaries (${outbound.length})`);
      for (const b of outbound.slice(0, 15)) {
        lines.push(`- [${b.method ?? 'HTTP'}] ${b.target ?? b.url ?? '?'}${b.backendTargetHint ? ` (hint: ${b.backendTargetHint})` : ''}`);
      }
    }
    const items: AnyRecord[] = ws.impactData?.data?.items ?? [];
    const focusedImpact = ws.selectedImpact.size > 0
      ? items.filter((it) => ws.selectedImpact.has(`${it.relPath}:${it.line}`))
      : items;
    if (focusedImpact.length > 0) {
      lines.push(`\n## Impact Sites (${ws.selectedImpact.size > 0 ? `${focusedImpact.length} selected` : focusedImpact.length})`);
      for (const it of focusedImpact.slice(0, 25)) {
        lines.push(`- [${it.kind}] ${it.relPath}:${it.line}`);
      }
    }
    const omissions: AnyRecord[] = ws.impactData?.omissions ?? [];
    if (omissions.length > 0) {
      lines.push(`\n## Omissions (${omissions.length})`);
      for (const om of omissions.slice(0, 15)) {
        lines.push(`- [${om.code}] ${om.filePath}:${om.line} — ${om.reason}`);
      }
    }
    return lines.join('\n');
  }

  return null;
}

async function sendAiAction(mode: 'context' | 'message', explicitPrompt?: string): Promise<void> {
  const ws = getWorkspaceState(activeWorkspace);
  const context = buildCompactContext(currentTab, ws);
  if (!context) {
    setStatus('No active Strata context to send yet.');
    return;
  }
  const caps = app.getHostCapabilities();
  try {
    if (mode === 'context') {
      if (!caps?.updateModelContext) return;
      await app.updateModelContext({ content: [{ type: 'text', text: context }] });
      const selCount = getSelectionCount(currentTab, ws);
      setStatus(selCount > 0 ? `Attached ${selCount} selected item(s) to model context.` : `Attached ${currentTab} context to model.`);
      return;
    }

    const instruction = (explicitPrompt ?? promptDraft).trim() || DEFAULT_ASK_PROMPT[currentTab];
    const messageText = `${instruction}\n\n${context}`;
    if (caps?.message) {
      await app.sendMessage({ role: 'user', content: [{ type: 'text', text: messageText }] });
      if (!explicitPrompt && promptDraft.trim()) {
        promptDraft = '';
        const inp = document.getElementById('ai-prompt-input') as HTMLInputElement | null;
        if (inp) inp.value = '';
      }
      setStatus('Sent instruction + Strata context to conversation.');
    } else if (caps?.updateModelContext) {
      await app.updateModelContext({ content: [{ type: 'text', text: messageText }] });
      setStatus('Host does not support direct messages; attached to model context instead.');
    }
  } catch (err: unknown) {
    setStatus(err instanceof Error ? err.message : String(err));
  }
}

function renderDiagnosticsNotice(ws: WorkspaceViewState): string {
  const activeEnv = currentTab === 'overview' ? ws.overview : currentTab === 'routes' ? ws.routes : ws.impactData;
  const diags = [
    ...(activeEnv?.diagnostics ?? []),
    ...(currentTab === 'overview' ? ws.health?.diagnostics ?? [] : []),
  ];
  const omissionsCount = currentTab === 'tree' ? (ws.impactData?.omissions?.length ?? 0) : 0;
  const fallback = activeEnv?.verification === 'syntax-fallback';

  if (diags.length === 0 && !fallback && omissionsCount === 0) return '';

  const notes: string[] = [];
  if (fallback) notes.push('Verification fell back to <code>syntax-fallback</code> (check tsconfig/semantic setup).');
  if (omissionsCount > 0) notes.push(`${omissionsCount} dynamic omission(s) detected (e.g. <code>v-bind</code> / <code>{...props}</code>) requiring manual verification.`);
  for (const d of diags.slice(0, 3)) {
    notes.push(`<code>[${esc(d.code)}]</code> ${esc(d.message)}`);
  }

  return `
    <div class="warn-box">
      <div><strong>Diagnostics & Verification Notice</strong></div>
      ${notes.map((n) => `<div class="muted">${n}</div>`).join('')}
      <div><button type="button" id="btn-diagnose" class="mini-btn">Ask AI to Diagnose</button></div>
    </div>
  `;
}

function renderAiBar(ws: WorkspaceViewState): string {
  const caps = app.getHostCapabilities();
  const canMsg = Boolean(caps?.message);
  const canCtx = Boolean(caps?.updateModelContext);
  if (!canMsg && !canCtx) return '';

  const hasContext = Boolean(buildCompactContext(currentTab, ws));
  if (!hasContext) return '';

  const selCount = getSelectionCount(currentTab, ws);
  const presets = TAB_PRESETS[currentTab];

  return `
    <section class="ai-bar">
      <div class="ai-presets">
        <span class="muted">AI Actions${selCount > 0 ? ` (${selCount} selected)` : ''}:</span>
        ${canMsg ? presets.map((p, idx) => `<button type="button" class="mini-btn" data-preset="${idx}">${esc(p.label)}</button>`).join('') : ''}
        ${canCtx ? '<button type="button" id="btn-attach" class="mini-btn">Attach Context</button>' : ''}
        ${selCount > 0 ? '<button type="button" id="btn-clear-sel" class="mini-btn">Clear Selection</button>' : ''}
      </div>
      ${canMsg ? `
        <form id="ai-prompt-form" class="ai-form">
          <input id="ai-prompt-input" type="text" placeholder="Ask AI about this ${esc(currentTab)} view..." value="${esc(promptDraft)}" />
          <button type="submit" class="primary-btn">Ask AI</button>
        </form>
      ` : ''}
    </section>
  `;
}

function shortNodeLabel(name: string, max = 18): string {
  return name.length > max ? `${name.slice(0, max - 1)}…` : name;
}

function renderComponentGraphSvg(ws: WorkspaceViewState): string {
  const tree = ws.treeData?.data?.tree;
  if (!tree) return '';

  const seenConsumers = new Set<string>();
  const consumers: Array<{ label: string; filePath: string }> = [];
  for (const it of ws.impactData?.data?.items ?? []) {
    if (!it.filePath || it.filePath === ws.selectedComponentPath || seenConsumers.has(it.filePath)) continue;
    seenConsumers.add(it.filePath);
    const base = String(it.relPath ?? it.filePath).split('/').pop() ?? it.filePath;
    consumers.push({ label: shortNodeLabel(base), filePath: it.filePath });
    if (consumers.length >= 5) break;
  }

  const children: Array<{ label: string; filePath: string }> = [];
  for (const c of tree.children ?? []) {
    if (!c?.filePath) continue;
    children.push({ label: shortNodeLabel(c.componentName ?? c.relPath ?? 'child'), filePath: c.filePath });
    if (children.length >= 5) break;
  }

  const rows = Math.max(1, consumers.length, children.length);
  const rowH = 32;
  const height = Math.max(88, rows * rowH + 24);
  const centerY = Math.round(height / 2) - 13;

  const boxW = 136;
  const boxH = 26;
  const xLeft = 10;
  const xMid = 192;
  const xRight = 374;

  const leftNodes = consumers.map((c, idx) => {
    const y = Math.round(((idx + 0.5) / consumers.length) * (height - 16)) - 10;
    const edge = `<path class="graph-edge" d="M ${xLeft + boxW} ${y + boxH / 2} C ${xLeft + boxW + 22} ${y + boxH / 2}, ${xMid - 22} ${centerY + boxH / 2}, ${xMid} ${centerY + boxH / 2}" />`;
    const node = `<g class="graph-node" data-inspect-svg="${esc(c.filePath)}"><rect x="${xLeft}" y="${y}" width="${boxW}" height="${boxH}" /><text x="${xLeft + 8}" y="${y + 17}">${esc(c.label)}</text></g>`;
    return edge + node;
  }).join('');

  const rightNodes = children.map((c, idx) => {
    const y = Math.round(((idx + 0.5) / children.length) * (height - 16)) - 10;
    const edge = `<path class="graph-edge" d="M ${xMid + boxW} ${centerY + boxH / 2} C ${xMid + boxW + 22} ${centerY + boxH / 2}, ${xRight - 22} ${y + boxH / 2}, ${xRight} ${y + boxH / 2}" />`;
    const node = `<g class="graph-node" data-inspect-svg="${esc(c.filePath)}"><rect x="${xRight}" y="${y}" width="${boxW}" height="${boxH}" /><text x="${xRight + 8}" y="${y + 17}">${esc(c.label)}</text></g>`;
    return edge + node;
  }).join('');

  const centerNode = `<g class="graph-node center"><rect x="${xMid}" y="${centerY}" width="${boxW}" height="${boxH}" /><text x="${xMid + 8}" y="${centerY + 17}" font-weight="600">${esc(shortNodeLabel(tree.componentName ?? 'Selected'))}</text></g>`;

  return `
    <div class="graph-wrap" title="Click any neighbor node to inspect it">
      <svg class="graph-svg" viewBox="0 0 520 ${height}" xmlns="http://www.w3.org/2000/svg">
        <text x="${xLeft}" y="12" font-size="10" fill="currentColor" opacity="0.6">Consumers (${consumers.length})</text>
        <text x="${xMid}" y="12" font-size="10" fill="currentColor" opacity="0.6">Selected</text>
        <text x="${xRight}" y="12" font-size="10" fill="currentColor" opacity="0.6">Renders (${children.length})</text>
        ${leftNodes}
        ${rightNodes}
        ${centerNode}
      </svg>
    </div>
  `;
}

function renderSlicePreviewDrawer(ws: WorkspaceViewState): string {
  const sp = ws.slicePreview;
  if (!sp) return '';
  return `
    <section class="slice-drawer">
      <div class="slice-head">
        <span><strong>Slice Preview:</strong> <code>${esc(sp.filePath)}</code> <span class="muted">(lines ${sp.startLine}–${sp.endLine} of ${sp.totalLines})</span></span>
        <div class="actions">
          <button type="button" class="mini-btn" data-open="${esc(sp.filePath)}">Open in Pane</button>
          <button type="button" id="btn-close-slice" class="mini-btn">Close</button>
        </div>
      </div>
      <pre class="slice-code">${esc(sp.content)}</pre>
    </section>
  `;
}

function renderTreeHtml(node: any, depth = 0): string {
  if (!node) return '';
  const pad = depth * 14;
  const badge = node.isPage ? '<span class="badge">page</span>' : '';
  const children = Array.isArray(node.children)
    ? node.children.map((c: any) => renderTreeHtml(c, depth + 1)).join('')
    : '';
  return `
    <div class="tree-node" style="padding-left:${pad}px">
      <button class="link-btn" data-open="${esc(node.filePath)}">${esc(node.componentName)}</button>
      <span class="muted">${esc(node.relPath)}</span> ${badge}
      <button class="mini-btn" data-preview="${esc(node.filePath)}">Preview</button>
      <button class="mini-btn" data-inspect="${esc(node.filePath)}">Inspect</button>
    </div>
    ${children}
  `;
}

function render(): void {
  const rootEl = document.getElementById('app');
  if (!rootEl) return;

  const ws = getWorkspaceState(activeWorkspace);
  const totals = ws.overview?.data?.totals;
  const packages = ws.overview?.data?.packages ?? [];
  const unused = ws.health?.data?.health?.unusedComponents ?? [];
  const routes = (ws.routes?.data?.routes ?? []).filter((r: any) => {
    if (!ws.routeFilter) return true;
    const q = ws.routeFilter.toLowerCase();
    return String(r.urlPath).toLowerCase().includes(q) || String(r.relPath).toLowerCase().includes(q);
  });
  const outboundHttp = ws.inspectData?.data?.boundaries?.outboundHttp ?? [];

  const wsSelector = knownWorkspaces.length > 1
    ? `<select id="workspace-select" class="ws-select" title="Switch workspace">
        ${knownWorkspaces.map((w) => `<option value="${esc(w)}" ${w === activeWorkspace ? 'selected' : ''}>${esc(shortWorkspaceLabel(w))}</option>`).join('')}
      </select>`
    : (activeWorkspace ? `<span class="muted scope-pill" title="${esc(activeWorkspace)}">${esc(shortWorkspaceLabel(activeWorkspace))}</span>` : '');

  rootEl.innerHTML = `
    <header class="topbar">
      <div class="brand">
        <strong>Strata Explorer</strong>
        ${wsSelector}
      </div>
      <div class="actions">
        <nav class="tabs">
          <button class="tab ${currentTab === 'overview' ? 'active' : ''}" data-tab="overview">Overview & Health</button>
          <button class="tab ${currentTab === 'routes' ? 'active' : ''}" data-tab="routes">Routes</button>
          <button class="tab ${currentTab === 'tree' ? 'active' : ''}" data-tab="tree">Tree & Impact</button>
        </nav>
        <button id="btn-refresh-active" class="mini-btn" title="Refresh active view">Refresh</button>
      </div>
    </header>

    <div id="status-bar" class="status-bar">${loading ? 'Loading...' : esc(statusMsg)}</div>
    ${lastError ? `<div class="alert">${esc(lastError)}</div>` : ''}
    ${renderDiagnosticsNotice(ws)}

    <main class="content">
      ${currentTab === 'overview' ? `
        ${totals ? `
          <section class="stats-grid">
            <div class="stat"><div class="stat-val">${esc(totals.packages)}</div><div class="stat-lbl">Packages</div></div>
            <div class="stat"><div class="stat-val">${esc(totals.files)}</div><div class="stat-lbl">Files</div></div>
            <div class="stat"><div class="stat-val">${esc(totals.symbols)}</div><div class="stat-lbl">Symbols</div></div>
            <div class="stat"><div class="stat-val">${esc(totals.routes)}</div><div class="stat-lbl">Routes</div></div>
          </section>
        ` : '<p class="muted">Run or refresh workspace overview.</p>'}

        ${packages.length ? `
          <h3>Packages</h3>
          <div class="list">
            ${packages.map((p: any) => `
              <div class="row">
                <span><strong>${esc(p.packageKey)}</strong> <span class="badge">${esc(p.framework)}</span></span>
                <span class="muted">${esc(p.fileCount)} files · ${esc(p.symbolCount)} symbols · ${esc(p.routeCount)} routes</span>
              </div>
            `).join('')}
          </div>
        ` : ''}

        <div class="section-head">
          <h3>Unused Component Candidates (${unused.length})</h3>
        </div>
        <div class="list">
          ${unused.length ? unused.map((c: any) => `
            <div class="row">
              <label class="check-row">
                <input type="checkbox" class="health-chk" value="${esc(c.relPath)}" ${ws.selectedHealth.has(c.relPath) ? 'checked' : ''} />
                <span><strong>${esc(c.name)}</strong> <span class="muted">${esc(c.relPath)}:${esc(c.line)}</span></span>
              </label>
              <div>
                <button class="mini-btn" data-preview="${esc(c.filePath)}" data-preview-line="${esc(c.line)}">Preview</button>
                <button class="mini-btn" data-inspect="${esc(c.filePath)}">Tree</button>
                <button class="mini-btn" data-open="${esc(c.filePath)}">Open</button>
              </div>
            </div>
          `).join('') : '<p class="muted">No unused component candidates reported.</p>'}
        </div>
        ${ws.health?.pagination?.hasMore ? `
          <div class="pager-row">
            <span class="muted">Showing ${unused.length} of ${esc(ws.health.pagination.total)}</span>
            <button id="btn-more-health" class="mini-btn">Load More Candidates</button>
          </div>
        ` : ''}
      ` : ''}

      ${currentTab === 'routes' ? `
        <div class="search-row">
          <input id="route-filter" type="search" placeholder="Filter routes by URL or file path..." value="${esc(ws.routeFilter)}" />
        </div>
        <div class="list">
          ${routes.length ? routes.map((r: any) => `
            <div class="row">
              <label class="check-row">
                <input type="checkbox" class="route-chk" value="${esc(r.relPath)}" ${ws.selectedRoutes.has(r.relPath) ? 'checked' : ''} />
                <span><code>${esc(r.urlPath)}</code> <span class="badge">${esc(r.routeType)}</span></span>
              </label>
              <div>
                <span class="muted">${esc(r.relPath)}</span>
                <button class="mini-btn" data-preview="${esc(r.filePath)}">Preview</button>
                <button class="mini-btn" data-open="${esc(r.filePath)}">Open</button>
              </div>
            </div>
          `).join('') : '<p class="muted">No routes matched.</p>'}
        </div>
        ${ws.routes?.pagination?.hasMore ? `
          <div class="pager-row">
            <span class="muted">Showing ${ws.routes?.data?.routes?.length ?? routes.length} of ${esc(ws.routes.pagination.total)}</span>
            <button id="btn-more-routes" class="mini-btn">Load More Routes</button>
          </div>
        ` : ''}
      ` : ''}

      ${currentTab === 'tree' ? `
        <form id="comp-search-form" class="search-row">
          <input id="comp-search-input" type="search" placeholder="Search component name (e.g. HomeLogoCarousel)..." value="${esc(ws.searchQuery)}" />
          <button type="submit" class="primary-btn">Search</button>
        </form>

        ${ws.searchResults.length ? `
          <div class="list">
            ${ws.searchResults.map((m) => `
              <div class="row">
                <span><strong>${esc(m.name)}</strong> <span class="muted">${esc(m.relPath)}:${esc(m.line)}</span></span>
                <div>
                  <button class="mini-btn" data-preview="${esc(m.filePath)}" data-preview-line="${esc(m.line)}">Preview</button>
                  <button class="mini-btn" data-inspect="${esc(m.filePath)}">Inspect</button>
                </div>
              </div>
            `).join('')}
          </div>
        ` : ''}

        ${ws.selectedComponentPath ? `
          <h3>Component Graph & Tree</h3>
          ${renderComponentGraphSvg(ws)}
          <div class="card">
            ${ws.treeData?.data?.tree ? renderTreeHtml(ws.treeData.data.tree) : '<p class="muted">No tree data.</p>'}
          </div>

          <h3>Contract & Boundaries</h3>
          <div class="card">
            ${ws.inspectData?.data?.contract ? `
              <div><strong>Props:</strong> ${esc((ws.inspectData.data.contract.props ?? []).map((p: any) => `${p.name}${p.required ? '' : '?'}: ${p.type}`).join(', ') || 'none')}</div>
              <div><strong>Emits:</strong> ${esc((ws.inspectData.data.contract.emits ?? []).join(', ') || 'none')}</div>
              <div><strong>Slots:</strong> ${esc((ws.inspectData.data.contract.slots ?? []).join(', ') || 'none')}</div>
            ` : '<p class="muted">No contract loaded.</p>'}
            ${outboundHttp.length ? `
              <div style="margin-top:6px"><strong>Outbound HTTP (${outboundHttp.length}):</strong></div>
              ${outboundHttp.map((b: any) => `
                <div class="row" style="margin-top:4px">
                  <span class="muted"><code>${esc(b.method ?? 'HTTP')} ${esc(b.target ?? b.url ?? '?')}</code>${b.backendTargetHint ? ` → hint: <code>${esc(b.backendTargetHint)}</code>` : ''}</span>
                  <button type="button" class="pill-btn" data-trace-method="${esc(b.method ?? 'HTTP')}" data-trace-target="${esc(b.target ?? b.url ?? '')}" data-trace-hint="${esc(b.backendTargetHint ?? '')}">Trace Backend (Septum)</button>
                </div>
              `).join('')}
            ` : ''}
          </div>

          <h3>Impact Sites (${ws.impactData?.data?.items?.length ?? 0}) & Omissions (${ws.impactData?.omissions?.length ?? 0})</h3>
          <div class="list">
            ${(ws.impactData?.data?.items ?? []).map((it: any) => {
              const key = `${it.relPath}:${it.line}`;
              return `
                <div class="row">
                  <label class="check-row">
                    <input type="checkbox" class="impact-chk" value="${esc(key)}" ${ws.selectedImpact.has(key) ? 'checked' : ''} />
                    <span><code>${esc(it.relPath)}:${esc(it.line)}</code> <span class="badge">${esc(it.kind)}</span></span>
                  </label>
                  <div>
                    <button class="mini-btn" data-preview="${esc(it.filePath)}" data-preview-line="${esc(it.line)}">Preview</button>
                    <button class="mini-btn" data-open="${esc(it.filePath)}">Open</button>
                  </div>
                </div>
              `;
            }).join('')}
            ${(ws.impactData?.omissions ?? []).map((om: any) => `
              <div class="row warn-row">
                <span><strong>[${esc(om.code)}]</strong> ${esc(om.filePath)}:${esc(om.line)} — ${esc(om.reason)}</span>
                <div>
                  <button class="mini-btn" data-preview="${esc(om.filePath)}" data-preview-line="${esc(om.line)}">Preview</button>
                  <button class="mini-btn" data-open="${esc(om.filePath)}">Open</button>
                </div>
              </div>
            `).join('')}
          </div>
        ` : '<p class="muted">Search for a component or click "Tree" on any item to inspect its hierarchy and impact.</p>'}
      ` : ''}

      ${renderSlicePreviewDrawer(ws)}
      ${renderAiBar(ws)}
    </main>
  `;

  rootEl.querySelectorAll<HTMLButtonElement>('[data-tab]').forEach((btn) => {
    btn.onclick = () => void loadTab(btn.dataset.tab as TabKind);
  });

  const wsSelect = document.getElementById('workspace-select') as HTMLSelectElement | null;
  if (wsSelect) {
    wsSelect.onchange = () => {
      activeWorkspace = wsSelect.value;
      void loadTab(currentTab, activeWorkspace);
    };
  }

  document.getElementById('btn-refresh-active')?.addEventListener('click', () => {
    if (currentTab === 'overview') {
      ws.overview = null;
      ws.health = null;
      void loadTab('overview');
    } else if (currentTab === 'routes') {
      ws.routes = null;
      void loadTab('routes');
    } else if (ws.selectedComponentPath) {
      void inspectComponent(ws.selectedComponentPath);
    }
  });

  rootEl.querySelectorAll<HTMLButtonElement>('[data-open]').forEach((btn) => {
    btn.onclick = () => void openFileInPane(btn.dataset.open ?? '');
  });
  rootEl.querySelectorAll<HTMLButtonElement>('[data-inspect]').forEach((btn) => {
    btn.onclick = () => void inspectComponent(btn.dataset.inspect ?? '');
  });
  rootEl.querySelectorAll<SVGGElement>('[data-inspect-svg]').forEach((el) => {
    el.onclick = () => void inspectComponent(el.dataset.inspectSvg ?? '');
  });
  rootEl.querySelectorAll<HTMLButtonElement>('[data-preview]').forEach((btn) => {
    btn.onclick = () => {
      const line = btn.dataset.previewLine ? Number(btn.dataset.previewLine) : undefined;
      void previewSlice(btn.dataset.preview ?? '', Number.isFinite(line) ? line : undefined);
    };
  });
  rootEl.querySelectorAll<HTMLButtonElement>('[data-trace-method]').forEach((btn) => {
    btn.onclick = () => {
      void traceBackendWithSeptum(
        btn.dataset.traceMethod ?? 'HTTP',
        btn.dataset.traceTarget ?? '',
        btn.dataset.traceHint ?? ''
      );
    };
  });
  document.getElementById('btn-more-health')?.addEventListener('click', () => void loadMoreHealth());
  document.getElementById('btn-more-routes')?.addEventListener('click', () => void loadMoreRoutes());
  document.getElementById('btn-close-slice')?.addEventListener('click', () => {
    ws.slicePreview = null;
    render();
  });

  rootEl.querySelectorAll<HTMLInputElement>('.health-chk').forEach((chk) => {
    chk.onchange = () => {
      if (chk.checked) ws.selectedHealth.add(chk.value);
      else ws.selectedHealth.delete(chk.value);
      render();
    };
  });
  rootEl.querySelectorAll<HTMLInputElement>('.route-chk').forEach((chk) => {
    chk.onchange = () => {
      if (chk.checked) ws.selectedRoutes.add(chk.value);
      else ws.selectedRoutes.delete(chk.value);
      render();
    };
  });
  rootEl.querySelectorAll<HTMLInputElement>('.impact-chk').forEach((chk) => {
    chk.onchange = () => {
      if (chk.checked) ws.selectedImpact.add(chk.value);
      else ws.selectedImpact.delete(chk.value);
      render();
    };
  });

  const routeFilterInput = document.getElementById('route-filter') as HTMLInputElement | null;
  if (routeFilterInput) {
    routeFilterInput.oninput = () => {
      ws.routeFilter = routeFilterInput.value;
      render();
      const refocused = document.getElementById('route-filter') as HTMLInputElement | null;
      if (refocused) {
        refocused.focus();
        refocused.setSelectionRange(refocused.value.length, refocused.value.length);
      }
    };
  }

  const searchForm = document.getElementById('comp-search-form');
  if (searchForm) {
    searchForm.onsubmit = (e) => {
      e.preventDefault();
      const inp = document.getElementById('comp-search-input') as HTMLInputElement | null;
      void searchComponents(inp?.value ?? '');
    };
  }

  const promptInput = document.getElementById('ai-prompt-input') as HTMLInputElement | null;
  if (promptInput) {
    promptInput.oninput = () => {
      promptDraft = promptInput.value;
    };
  }
  document.getElementById('ai-prompt-form')?.addEventListener('submit', (e) => {
    e.preventDefault();
    void sendAiAction('message');
  });
  rootEl.querySelectorAll<HTMLButtonElement>('[data-preset]').forEach((btn) => {
    btn.onclick = () => {
      const idx = Number(btn.dataset.preset);
      const preset = TAB_PRESETS[currentTab][idx];
      if (preset) void sendAiAction('message', preset.prompt);
    };
  });
  document.getElementById('btn-attach')?.addEventListener('click', () => void sendAiAction('context'));
  document.getElementById('btn-clear-sel')?.addEventListener('click', () => {
    clearSelection(currentTab, ws);
    render();
  });
  document.getElementById('btn-diagnose')?.addEventListener('click', () => {
    void sendAiAction('message', 'Diagnose the verification/omission/diagnostic warnings shown in Strata Explorer and recommend concrete fixes.');
  });
}

// Register handlers BEFORE connect() per MCP App lifecycle
app.ontoolinput = ({ arguments: args }) => {
  if (args && typeof args.root === 'string' && args.root.trim()) {
    pendingWorkspaceRoot = args.root.trim();
  }
  setStatus('Running Strata analysis...');
};

app.ontoolresult = (result) => {
  lastError = null;
  if (result.isError) {
    lastError = (result.content?.[0] as { text?: string } | undefined)?.text ?? 'Tool execution failed.';
    setStatus('');
    render();
    return;
  }

  const env = extractEnvelope(result as AnyRecord);
  const resolvedRoot = env?.scope?.trim() || pendingWorkspaceRoot || activeWorkspace;
  if (resolvedRoot) registerWorkspace(resolvedRoot);
  pendingWorkspaceRoot = undefined;

  const ws = getWorkspaceState(resolvedRoot ?? activeWorkspace);
  const view = env?.data?.view;
  if (view === 'routes') {
    ws.routes = env;
    currentTab = 'routes';
  } else if (view === 'health') {
    ws.health = env;
    currentTab = 'overview';
  } else if (env) {
    ws.overview = env;
    currentTab = 'overview';
    if (!ws.health) {
      void callStrataTool('map_workspace', { view: 'health', limit: 50 }, resolvedRoot).then((h) => {
        ws.health = h;
        render();
      });
    }
  }
  setStatus('');
  render();
};

app.onhostcontextchanged = (ctx) => {
  if (ctx.theme) applyDocumentTheme(ctx.theme);
  if (ctx.styles?.variables) applyHostStyleVariables(ctx.styles.variables);
};

async function init(): Promise<void> {
  render();
  try {
    await app.connect();
    const ctx = app.getHostContext();
    if (ctx?.theme) applyDocumentTheme(ctx.theme);
    if (ctx?.styles?.variables) applyHostStyleVariables(ctx.styles.variables);
    render();
  } catch (err) {
    lastError = err instanceof Error ? err.message : String(err);
    render();
  }
}

void init();
