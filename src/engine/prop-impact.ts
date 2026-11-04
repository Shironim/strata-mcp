import { parse, NodeTypes, type RootNode, type TemplateChildNode } from '@vue/compiler-dom';
import { basename, extname, resolve } from 'node:path';
import { collectFiles } from './collector';
import { readSourceSnapshot } from './source-file';
import { parseSfc } from './splitter';
import { inspectVueTreeInput } from './graph/vue-tree-input';
import { extractImports, resolveImportPath } from './graph/path-helpers';
import { resolveBarrelExport } from './graph/resolution';
import { loadAliasConfig } from './resolver';
import { getCandidateNames } from './template';
import { hashRetrievalIdentity } from './retrieval-evidence';
import type { ComponentPropContract, PropImpactResult, PropUsage, SourceRef } from '../types';

const normalizeProp = (name: string) => name.replace(/-([a-z])/g, (_, char: string) => char.toUpperCase());

export function formatPropImpactAsText(result: PropImpactResult): string {
  return [
    `Prop impact (${result.status}; scope=${result.scope}; freshness=${result.freshness}; unknown consumers: unknown):`,
    ...result.props.flatMap(prop => [
      `- ${prop.name}: ${prop.confirmedConsumerCount} confirmed consumers / ${prop.confirmedUsageCount} usages; ${prop.candidateConsumerCount} candidate consumers; rename/remove=${prop.risk.renameOrRemove}`,
      `  Omitted in ${prop.omittedRenderCount} resolved renders / ${prop.omittedConsumerCount} consumers; ${prop.indeterminateRenderCount} resolved renders have indeterminate supply.`,
      ...prop.risk.reasons.map(reason => `  Risk: ${reason}`),
      ...(prop.usages ?? []).map(usage => `  ${usage.file} [${usage.resolution}] ${JSON.stringify(usage.sourceRef)}: ${usage.kind}; ${usage.reason}`),
      ...(prop.omissions ?? []).map(item => `  Omitted: ${item.file} ${JSON.stringify(item.sourceRef)}`),
    ]),
    ...result.diagnostics.map(item => `${item.code}: ${item.file}: ${item.reason}`),
    ...result.limitations,
  ].join('\n');
}

/** One workspace discovery and one template pass per file, shared across all declared props. */
export async function analyzePropImpact(options: {
  target: string; workspace: string; props: ComponentPropContract[]; detail: 'summary' | 'full';
}): Promise<PropImpactResult> {
  const target = resolve(options.target);
  const scope = resolve(options.workspace);
  const diagnostics: PropImpactResult['diagnostics'] = [];
  const usages = new Map(options.props.map(prop => [normalizeProp(prop.name), [] as PropUsage[]]));
  const inputs = new Map<string, string>();
  const renders = new Set<string>();
  const omissions = new Map(options.props.map(prop => [normalizeProp(prop.name), [] as Array<{ file: string; sourceRef: SourceRef }>]));
  const indeterminate = new Map(options.props.map(prop => [normalizeProp(prop.name), 0]));
  const limitations = [
    'Counts are observed static usages in the collected scope, not complete runtime consumer counts; unknownConsumerCount remains null.',
    'Only Vue HTML templates are scanned. Confirmed bindings require explicit static script-setup imports; auto/global registration, scoped bindings and dynamic components remain candidates.',
    'Ignore rules, files outside scope, render functions, resolver/config/dependency closure and runtime execution are not certified. Zero observed usages does not establish safe removal.',
    'Risk describes rename/remove impact. Requiredness, defaults and type changes also require reviewing consumers that omit the prop.',
  ];
  if (extname(target) !== '.vue') {
    return { status: 'unsupported', target, scope, freshness: 'unverified', inputIdentity: hashRetrievalIdentity({ target, scope }),
      renderConsumerCount: 0, unknownConsumerCount: null, props: [], diagnostics: [{ file: target, code: 'PROP_IMPACT_UNSUPPORTED', reason: 'Prop impact currently supports Vue targets only.' }], limitations };
  }
  const targetNames = new Set(getCandidateNames(basename(target, '.vue')).map(name => name.toLowerCase()));
  for (const file of (await collectFiles(scope)).sort()) {
    if (resolve(file) === target) continue;
    if (extname(file) !== '.vue') {
      diagnostics.push({ file, code: 'PROP_IMPACT_UNSCANNED', reason: 'Non-Vue source is outside template consumer analysis; it may contain render or registration references.' });
      continue;
    }
    try {
      const { content, snapshot } = await readSourceSnapshot(file);
      inputs.set(file, snapshot.sha256);
      const issue = inspectVueTreeInput(content, file);
      if (issue) { diagnostics.push({ file, code: issue.code, reason: issue.reason }); continue; }
      const sfc = parseSfc(content, file);
      if (!sfc.template) continue;
      const config = await loadAliasConfig(file);
      const setupImports = new Set(sfc.scriptSetup ? extractImports(`<script setup>${sfc.scriptSetup.content}</script>`, file)
        .filter(imp => !imp.isDynamic).map(imp => imp.alias || imp.name) : []);
      const bindings = new Map<string, { kind: 'target' | 'other' | 'unresolved'; confirmed: boolean }>();
      for (const imp of extractImports(content, file)) {
        const localName = imp.alias || imp.name;
        const local = imp.source.startsWith('.') || imp.source.startsWith('/') || config?.isAlias(imp.source);
        let path = local ? resolveImportPath(file, imp.source, config) : null;
        if (path && /[/\\]index\.[tj]sx?$/.test(path)) path = resolveBarrelExport(path, imp.name, config) ?? path;
        const kind = path ? resolve(path) === target ? 'target' : 'other' : 'unresolved';
        for (const name of getCandidateNames(localName)) bindings.set(name.toLowerCase(), { kind, confirmed: kind === 'target' && !imp.isDynamic && setupImports.has(localName) });
      }
      const offset = sfc.template.loc.start.offset;
      const add = (name: string | null, node: { loc: { start: { offset: number }; end: { offset: number } } },
        tag: string, kind: PropUsage['kind'], resolution: PropUsage['resolution'], reason: string) => {
        const entry: PropUsage = { file, tag, kind, resolution, reason,
          sourceRef: { sha256: snapshot.sha256, startOffset: offset + node.loc.start.offset, endOffset: offset + node.loc.end.offset } };
        if (name === null) { for (const values of usages.values()) values.push(entry); }
        else usages.get(normalizeProp(name))?.push(entry);
      };
      const walk = (node: RootNode | TemplateChildNode, scoped: boolean): void => {
        if (node.type !== NodeTypes.ROOT && node.type !== NodeTypes.ELEMENT) return;
        let childScoped = scoped;
        if (node.type === NodeTypes.ELEMENT) {
          childScoped ||= node.props.some(prop => prop.type === NodeTypes.DIRECTIVE && ['for', 'slot'].includes(prop.name));
          const binding = bindings.get(node.tag.toLowerCase());
          const dynamic = node.tag === 'component';
          const relevant = dynamic || binding?.kind === 'target' || binding?.kind === 'unresolved'
            || (!binding && targetNames.has(node.tag.toLowerCase()));
          if (relevant) {
            const confirmed = !dynamic && binding?.confirmed === true && !childScoped;
            if (confirmed) renders.add(file);
            if (confirmed) {
              const supplied = new Set<string>();
              let uncertain = false;
              for (const prop of node.props) {
                if (prop.type === NodeTypes.ATTRIBUTE) supplied.add(normalizeProp(prop.name));
                else if (prop.type === NodeTypes.DIRECTIVE && ['bind', 'model'].includes(prop.name)) {
                  if (prop.arg?.type === NodeTypes.SIMPLE_EXPRESSION && prop.arg.isStatic) supplied.add(normalizeProp(prop.arg.content));
                  else if (prop.name === 'model' && !prop.arg) supplied.add('modelValue');
                  else uncertain = true;
                }
              }
              for (const [name, entries] of omissions) {
                if (supplied.has(name)) continue;
                if (uncertain) indeterminate.set(name, indeterminate.get(name)! + 1);
                else entries.push({ file, sourceRef: { sha256: snapshot.sha256, startOffset: offset + node.loc.start.offset, endOffset: offset + node.loc.end.offset } });
              }
            }
            const resolution = confirmed ? 'resolved' : 'candidate';
            const reason = confirmed ? 'Explicit static script-setup import resolves to the target.'
              : 'Runtime registration, selector, scoped name or import binding is not fully resolved to the target.';
            if (!confirmed) diagnostics.push({ file, code: 'PROP_IMPACT_CANDIDATE', reason: `${node.tag}: ${reason}` });
            if (dynamic) add(null, node, node.tag, 'possible-binding', 'candidate', 'Dynamic component may supply any target prop; runtime target is unresolved.');
            else for (const prop of node.props) {
              if (prop.type === NodeTypes.ATTRIBUTE) add(prop.name, prop, node.tag, 'attribute', resolution, reason);
              else if (prop.type === NodeTypes.DIRECTIVE && prop.name === 'bind') {
                if (!prop.arg || prop.arg.type !== NodeTypes.SIMPLE_EXPRESSION || !prop.arg.isStatic)
                  add(null, prop, node.tag, 'possible-binding', 'candidate', 'Object forwarding or dynamic prop name may supply any target prop.');
                else add(prop.arg.content, prop, node.tag, 'binding', resolution, reason);
              } else if (prop.type === NodeTypes.DIRECTIVE && prop.name === 'model') {
                if (prop.arg && (prop.arg.type !== NodeTypes.SIMPLE_EXPRESSION || !prop.arg.isStatic))
                  add(null, prop, node.tag, 'possible-binding', 'candidate', 'Dynamic model argument may supply a target prop.');
                else add(prop.arg?.type === NodeTypes.SIMPLE_EXPRESSION ? prop.arg.content : 'modelValue', prop, node.tag, 'model', resolution, reason);
              }
            }
          }
        }
        for (const child of node.children) walk(child, childScoped);
      };
      walk(parse(sfc.template.content), false);
    } catch (error) {
      diagnostics.push({ file, code: 'PROP_IMPACT_ANALYSIS_FAILED', reason: error instanceof Error ? error.message : String(error) });
    }
  }
  let freshness: PropImpactResult['freshness'] = 'unverified';
  for (const [file, hash] of inputs) {
    try { if ((await readSourceSnapshot(file)).snapshot.sha256 === hash) continue; } catch { /* Missing/unreadable input is stale. */ }
    freshness = 'stale';
    diagnostics.push({ file, code: 'PROP_IMPACT_SOURCE_CHANGED', reason: 'An inspected consumer changed during impact analysis; retrieve again.' });
  }
  return { status: 'partial', target, scope, freshness, inputIdentity: hashRetrievalIdentity({ target, scope, props: options.props, inputs: [...inputs] }),
    renderConsumerCount: renders.size, unknownConsumerCount: null, diagnostics, limitations,
    props: options.props.map(prop => {
      const selected = usages.get(normalizeProp(prop.name)) ?? [];
      const confirmed = selected.filter(usage => usage.resolution === 'resolved');
      const candidates = selected.filter(usage => usage.resolution === 'candidate');
      const omitted = omissions.get(normalizeProp(prop.name)) ?? [];
      return { name: prop.name, confirmedConsumerCount: new Set(confirmed.map(usage => usage.file)).size,
        confirmedUsageCount: confirmed.length, candidateConsumerCount: new Set(candidates.map(usage => usage.file)).size,
        candidateUsageCount: candidates.length,
        omittedRenderCount: omitted.length, omittedConsumerCount: new Set(omitted.map(item => item.file)).size,
        indeterminateRenderCount: indeterminate.get(normalizeProp(prop.name)) ?? 0,
        risk: { renameOrRemove: confirmed.length ? 'affected' : 'unknown', reasons: [
          ...(confirmed.length ? ['Confirmed explicit usages require review when renaming or removing this prop.'] : ['No explicit resolved usage observed; this is not evidence that removal is safe.']),
          ...(candidates.length ? ['Candidate, forwarding or dynamic usages may also be affected.'] : []),
          'Discovery is partial; unresolved or out-of-scope usage remains possible.',
          ...(omitted.length ? ['Resolved renders omit this prop; review requiredness and default changes at these call sites.'] : []),
        ] }, ...(options.detail === 'full' ? { usages: selected, omissions: omitted } : {}) };
    }) };
}
