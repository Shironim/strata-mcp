import { resolve } from 'node:path';

export async function buildExplorerHtml(root: string): Promise<string> {
  const uiBundle = await Bun.build({
    entrypoints: [resolve(root, 'src', 'ui', 'explorer-client.ts')],
    target: 'browser',
    minify: true,
  });
  if (!uiBundle.success || uiBundle.outputs.length === 0) {
    throw new Error(`Failed to bundle Strata Explorer UI: ${uiBundle.logs.map(l => l.message).join('; ')}`);
  }
  const jsCode = (await uiBundle.outputs[0]!.text()).replace(/<\/script/gi, '<\\/script');
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width,initial-scale=1" />
<title>Strata Explorer</title>
<style>
  *, *::before, *::after { box-sizing: border-box; }
  body {
    margin: 0;
    padding: 12px;
    background: var(--color-background-primary, #ffffff);
    color: var(--color-text-primary, #1f2328);
    font-family: var(--font-sans, system-ui, -apple-system, sans-serif);
    font-size: 13px;
    line-height: 1.45;
  }
  .topbar { display: flex; flex-wrap: wrap; align-items: center; justify-content: space-between; gap: 8px; padding-bottom: 10px; border-bottom: 1px solid var(--color-border-primary, #d0d7de); }
  .brand { display: flex; align-items: center; gap: 8px; }
  .scope-pill { font-size: 11px; padding: 2px 6px; border-radius: 4px; background: var(--color-background-secondary, #f6f8fa); border: 1px solid var(--color-border-primary, #d0d7de); max-width: 260px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .tabs { display: flex; gap: 4px; }
  .tab { background: transparent; color: var(--color-text-secondary, #57606a); border: 1px solid var(--color-border-primary, #d0d7de); border-radius: 6px; padding: 4px 10px; cursor: pointer; font-size: 12px; }
  .tab.active { background: var(--color-background-secondary, #f6f8fa); color: var(--color-text-primary, #1f2328); font-weight: 600; }
  .status-bar { font-size: 11px; color: var(--color-text-secondary, #57606a); min-height: 16px; margin: 6px 0; }
  .stats-grid { display: grid; grid-template-columns: repeat(4, minmax(0, 1fr)); gap: 8px; margin-bottom: 12px; }
  .stat { padding: 8px 10px; border-radius: 6px; background: var(--color-background-secondary, #f6f8fa); border: 1px solid var(--color-border-primary, #d0d7de); }
  .stat-val { font-size: 18px; font-weight: 700; }
  .stat-lbl { font-size: 11px; color: var(--color-text-secondary, #57606a); }
  h3 { font-size: 13px; margin: 12px 0 6px; }
  .section-head { display: flex; align-items: center; justify-content: space-between; }
  .list { display: flex; flex-direction: column; gap: 4px; }
  .row { display: flex; align-items: center; justify-content: space-between; gap: 8px; padding: 6px 8px; border-radius: 6px; background: var(--color-background-secondary, #f6f8fa); border: 1px solid var(--color-border-primary, #d0d7de); }
  .warn-row { border-color: var(--color-border-warning, #d4a72c); }
  .check-row { display: flex; align-items: center; gap: 6px; cursor: pointer; }
  .card { padding: 8px 10px; border-radius: 6px; background: var(--color-background-secondary, #f6f8fa); border: 1px solid var(--color-border-primary, #d0d7de); }
  .tree-node { display: flex; align-items: center; gap: 6px; padding: 2px 0; }
  .search-row { display: flex; gap: 6px; margin-bottom: 10px; }
  .search-row input { flex: 1; padding: 5px 8px; border-radius: 6px; border: 1px solid var(--color-border-primary, #d0d7de); background: var(--color-background-primary, #ffffff); color: var(--color-text-primary, #1f2328); }
  .triage-bar { display: flex; align-items: center; gap: 8px; padding: 6px 8px; margin-bottom: 6px; border-radius: 6px; background: var(--color-background-info, #ddf4ff); border: 1px solid var(--color-border-info, #54aeff); }
  .alert { padding: 8px 10px; border-radius: 6px; margin-bottom: 8px; background: var(--color-background-danger, #fef2f2); color: var(--color-text-danger, #b91c1c); border: 1px solid var(--color-border-danger, #fecaca); }
  .warn-box { display: flex; flex-direction: column; gap: 6px; padding: 8px 10px; margin-bottom: 10px; border-radius: 6px; background: var(--color-background-warning, #fffbeb); color: var(--color-text-warning, #92400e); border: 1px solid var(--color-border-warning, #fde68a); }
  .ai-bar { display: flex; flex-direction: column; gap: 6px; margin-top: 12px; padding: 8px 10px; border-radius: 6px; background: var(--color-background-secondary, #f6f8fa); border: 1px solid var(--color-border-primary, #d0d7de); }
  .ai-presets { display: flex; flex-wrap: wrap; align-items: center; gap: 6px; }
  .ai-form { display: flex; gap: 6px; }
  .ai-form input { flex: 1; padding: 5px 8px; border-radius: 6px; border: 1px solid var(--color-border-primary, #d0d7de); background: var(--color-background-primary, #ffffff); color: var(--color-text-primary, #1f2328); font-size: 12px; }
  .ws-select { padding: 3px 6px; border-radius: 5px; border: 1px solid var(--color-border-primary, #d0d7de); background: var(--color-background-primary, #ffffff); color: var(--color-text-primary, #1f2328); font-size: 11px; max-width: 180px; }
  .actions { display: flex; align-items: center; gap: 6px; }
  .graph-wrap { overflow-x: auto; padding: 6px; border-radius: 6px; background: var(--color-background-primary, #ffffff); border: 1px solid var(--color-border-primary, #d0d7de); margin-bottom: 8px; }
  .graph-svg { display: block; min-width: 480px; width: 100%; height: auto; }
  .graph-node { cursor: pointer; }
  .graph-node rect { fill: var(--color-background-secondary, #f6f8fa); stroke: var(--color-border-primary, #d0d7de); stroke-width: 1.2; rx: 6; }
  .graph-node.center rect { fill: var(--color-background-info, #ddf4ff); stroke: var(--color-border-info, #54aeff); stroke-width: 1.8; }
  .graph-node:hover rect { stroke: var(--color-ring-primary, #3b82f6); }
  .graph-node text { fill: var(--color-text-primary, #1f2328); font-size: 11px; font-family: var(--font-sans, system-ui, sans-serif); }
  .graph-edge { stroke: var(--color-border-primary, #94a3b8); stroke-width: 1.2; fill: none; }
  .slice-drawer { margin-top: 10px; border: 1px solid var(--color-border-primary, #d0d7de); border-radius: 6px; background: var(--color-background-secondary, #f6f8fa); overflow: hidden; }
  .slice-head { display: flex; align-items: center; justify-content: space-between; gap: 8px; padding: 6px 10px; border-bottom: 1px solid var(--color-border-primary, #d0d7de); }
  .slice-code { margin: 0; padding: 8px 10px; max-height: 240px; overflow: auto; font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: 11px; line-height: 1.45; background: var(--color-background-primary, #ffffff); color: var(--color-text-primary, #1f2328); white-space: pre; }
  .pager-row { display: flex; align-items: center; justify-content: space-between; margin-top: 6px; }
  .pill-btn { border-radius: 999px; padding: 2px 8px; font-size: 11px; cursor: pointer; border: 1px solid var(--color-border-info, #54aeff); background: var(--color-background-info, #ddf4ff); color: var(--color-text-primary, #1f2328); }
  .badge { font-size: 11px; padding: 1px 5px; border-radius: 4px; background: var(--color-background-tertiary, #eaeef2); color: var(--color-text-secondary, #57606a); }
  .muted { color: var(--color-text-secondary, #57606a); font-size: 12px; }
  .mini-btn, .primary-btn { border-radius: 5px; padding: 3px 8px; font-size: 11px; cursor: pointer; border: 1px solid var(--color-border-primary, #d0d7de); background: var(--color-background-primary, #ffffff); color: var(--color-text-primary, #1f2328); }
  .primary-btn { font-weight: 600; }
  .link-btn { background: none; border: none; padding: 0; color: inherit; font-weight: 600; cursor: pointer; text-decoration: underline; }
  code { font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: 12px; }
</style>
</head>
<body>
<div id="app">Loading Strata Explorer...</div>
<script type="module">${jsCode}</script>
</body>
</html>`;
}
