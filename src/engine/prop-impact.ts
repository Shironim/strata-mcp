import { parse, NodeTypes, type RootNode, type TemplateChildNode } from '@vue/compiler-dom';
import { parse as parseSvelteAst } from 'svelte/compiler';
import ts from 'typescript';
import { basename, extname, resolve } from 'node:path';
import { collectFiles } from './collector';
import { readSourceSnapshot } from './source-file';
import { parseSfc } from './splitter';
import { parseAstro } from './astro-sfc';
import { astroExpressionEnd, astroOpeningTags } from './astro-template';
import { inspectVueTreeInput } from './graph/vue-tree-input';
import { extractImports } from './graph/path-helpers';
import { collectJsxComponentUses, resolveComponentImport } from './graph/component-relationships';
import { canonicalizePath } from './path-resolver';
import { parseTypeScript } from './source-parser';
import { loadAliasConfig } from './resolver';
import { getCandidateNames } from './template';
import { hashRetrievalIdentity } from './retrieval-evidence';
import type { ComponentPropContract, PropImpactResult, PropUsage, SourceRef } from '../types';

const normalizeProp = (name: string) => name.replace(/-([a-z])/g, (_, char: string) => char.toUpperCase());

type TargetBinding = { kind: 'target' | 'other' | 'unresolved'; confirmed: boolean };

async function resolveTargetBindings(
  content: string,
  file: string,
  target: string,
  confirmedNames?: Set<string>
): Promise<Map<string, TargetBinding>> {
  const config = await loadAliasConfig(file);
  const bindings = new Map<string, TargetBinding>();
  for (const imp of extractImports(content, file)) {
    const localName = imp.alias || imp.name;
    const { target: path } = resolveComponentImport(file, imp.source, imp.exportedName ?? imp.name, config);
    const kind = path ? path === target ? 'target' : 'other' : 'unresolved';
    const isConfirmed = kind === 'target' && !imp.isDynamic && (!confirmedNames || confirmedNames.has(localName));
    for (const name of getCandidateNames(localName)) bindings.set(name.toLowerCase(), { kind, confirmed: isConfirmed });
  }
  return bindings;
}

interface ScannedAstroAttr {
  name: string | null;
  kind: 'attribute' | 'possible-binding';
  start: number;
  end: number;
}

function scanAstroAttributesWithOffsets(attrString: string): ScannedAstroAttr[] {
  const result: ScannedAstroAttr[] = [];
  const len = attrString.length;
  let i = 0;
  while (i < len) {
    while (i < len && /\s/.test(attrString[i])) i++;
    if (i >= len) break;
    if (attrString[i] === '{') {
      const start = i;
      const end = astroExpressionEnd(attrString, i);
      const inner = attrString.slice(start + 1, Math.max(start + 1, end - 1)).trim();
      if (inner.startsWith('...')) {
        result.push({ name: null, kind: 'possible-binding', start, end });
      } else if (/^[A-Za-z_$][\w$-]*$/.test(inner)) {
        result.push({ name: inner, kind: 'attribute', start, end });
      }
      i = end;
      continue;
    }
    const keyStart = i;
    while (i < len && /[a-zA-Z0-9_:@.-]/.test(attrString[i])) i++;
    const key = attrString.slice(keyStart, i);
    if (!key) { i++; continue; }
    while (i < len && /\s/.test(attrString[i])) i++;
    let end = i;
    if (i < len && attrString[i] === '=') {
      i++;
      while (i < len && /\s/.test(attrString[i])) i++;
      if (i < len) {
        const quote = attrString[i];
        if (quote === '"' || quote === "'") {
          i++;
          while (i < len && attrString[i] !== quote) i += attrString[i] === '\\' ? 2 : 1;
          if (i < len && attrString[i] === quote) i++;
          end = i;
        } else if (quote === '{') {
          i = astroExpressionEnd(attrString, i);
          end = i;
        } else {
          while (i < len && !/[\s>]/.test(attrString[i])) i++;
          end = i;
        }
      }
    }
    if (/^(?:client|set|is|define):/.test(key)) continue;
    result.push({ name: key, kind: 'attribute', start: keyStart, end });
  }
  return result;
}

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
  const target = canonicalizePath(options.target);
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
  const targetExt = extname(target).toLowerCase();
  if (!['.vue', '.tsx', '.jsx', '.svelte', '.astro'].includes(targetExt)) {
    return { status: 'unsupported', target, scope, freshness: 'unverified', inputIdentity: hashRetrievalIdentity({ target, scope }),
      renderConsumerCount: 0, unknownConsumerCount: null, props: [], diagnostics: [{ file: target, code: 'PROP_IMPACT_UNSUPPORTED', reason: 'Prop impact currently supports Vue, React/JSX, Svelte, and Astro targets only.' }], limitations };
  }
  const targetNames = new Set(getCandidateNames(basename(target, targetExt)).map(name => name.toLowerCase()));
  const allowedConsumerExts = targetExt === '.vue' ? ['.vue']
    : (targetExt === '.tsx' || targetExt === '.jsx') ? ['.tsx', '.jsx']
      : targetExt === '.svelte' ? ['.svelte']
        : ['.astro'];

  for (const file of (await collectFiles(scope)).sort()) {
    if (resolve(file) === target) continue;
    const fileExt = extname(file).toLowerCase();
    if (!allowedConsumerExts.includes(fileExt)) {
      diagnostics.push({ file, code: 'PROP_IMPACT_UNSCANNED', reason: `Source (${fileExt || 'unknown'}) is outside same-framework template consumer analysis; it may contain render or registration references.` });
      continue;
    }
    try {
      const { content, snapshot } = await readSourceSnapshot(file);
      inputs.set(file, snapshot.sha256);

      if (fileExt === '.vue') {
        const issue = inspectVueTreeInput(content, file);
        if (issue) { diagnostics.push({ file, code: issue.code, reason: issue.reason }); continue; }
        const sfc = parseSfc(content, file);
        if (!sfc.template) continue;
        const setupImports = new Set(sfc.scriptSetup ? extractImports(`<script setup>${sfc.scriptSetup.content}</script>`, file)
          .filter(imp => !imp.isDynamic).map(imp => imp.alias || imp.name) : []);
        const bindings = await resolveTargetBindings(content, file, target, setupImports);
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
      } else if (fileExt === '.svelte') {
        const bindings = await resolveTargetBindings(content, file, target);
        const bom = content.charCodeAt(0) === 0xFEFF ? 1 : 0;
        const ast = parseSvelteAst(content.slice(bom), { modern: true, filename: file });
        const walkSvelte = (node: any): void => {
          if (!node || typeof node !== 'object') return;
          if (Array.isArray(node)) { for (const child of node) walkSvelte(child); return; }
          if (node.type === 'Component' || node.type === 'SvelteComponent') {
            const dynamic = node.type === 'SvelteComponent';
            const tagName = dynamic ? 'svelte:component' : String(node.name ?? '');
            const binding = dynamic ? undefined : bindings.get(tagName.toLowerCase());
            const relevant = dynamic || binding?.kind === 'target' || binding?.kind === 'unresolved'
              || (!binding && targetNames.has(tagName.toLowerCase()));
            if (relevant) {
              const confirmed = !dynamic && binding?.confirmed === true;
              if (confirmed) renders.add(file);
              const supplied = new Set<string>();
              let uncertain = false;
              for (const attr of node.attributes ?? []) {
                if (attr.type === 'Attribute' && attr.name) supplied.add(normalizeProp(attr.name));
                else if (attr.type === 'BindDirective' && attr.name) supplied.add(normalizeProp(attr.name));
                else if (attr.type === 'SpreadAttribute') uncertain = true;
              }
              if (confirmed) {
                for (const [name, entries] of omissions) {
                  if (supplied.has(name)) continue;
                  if (uncertain) indeterminate.set(name, indeterminate.get(name)! + 1);
                  else entries.push({ file, sourceRef: { sha256: snapshot.sha256, startOffset: node.start + bom, endOffset: node.end + bom } });
                }
              }
              const resolution = confirmed ? 'resolved' : 'candidate';
              const reason = confirmed ? 'Explicit static import resolves to the target.'
                : 'Dynamic component or unresolved import binding may supply a target prop.';
              if (!confirmed) diagnostics.push({ file, code: 'PROP_IMPACT_CANDIDATE', reason: `${tagName}: ${reason}` });
              if (dynamic) {
                const entry: PropUsage = { file, tag: tagName, kind: 'possible-binding', resolution: 'candidate',
                  reason: 'Dynamic <svelte:component> may supply any target prop.',
                  sourceRef: { sha256: snapshot.sha256, startOffset: node.start + bom, endOffset: node.end + bom } };
                for (const values of usages.values()) values.push(entry);
              } else {
                for (const attr of node.attributes ?? []) {
                  if ((attr.type === 'Attribute' || attr.type === 'BindDirective') && attr.name) {
                    const entry: PropUsage = { file, tag: tagName, kind: attr.type === 'BindDirective' ? 'model' : 'attribute',
                      resolution, reason, sourceRef: { sha256: snapshot.sha256, startOffset: attr.start + bom, endOffset: attr.end + bom } };
                    usages.get(normalizeProp(attr.name))?.push(entry);
                  } else if (attr.type === 'SpreadAttribute') {
                    const entry: PropUsage = { file, tag: tagName, kind: 'possible-binding', resolution: 'candidate',
                      reason: 'Svelte spread attribute {...props} may supply any target prop.',
                      sourceRef: { sha256: snapshot.sha256, startOffset: attr.start + bom, endOffset: attr.end + bom } };
                    for (const values of usages.values()) values.push(entry);
                  }
                }
              }
            }
          }
          for (const [key, child] of Object.entries(node)) {
            if (!['attributes', 'expression', 'metadata', 'loc', 'parent'].includes(key)) walkSvelte(child);
          }
        };
        walkSvelte(ast.fragment);
      } else if (fileExt === '.astro') {
        const astro = parseAstro(content, file);
        if (!astro.template) continue;
        const bindings = await resolveTargetBindings(content, file, target);
        const templateOffset = astro.template.loc.start.offset;
        for (const tag of astroOpeningTags(astro.template.content)) {
          const binding = bindings.get(tag.name.toLowerCase());
          const relevant = binding?.kind === 'target' || binding?.kind === 'unresolved'
            || (!binding && targetNames.has(tag.name.toLowerCase()));
          if (!relevant) continue;
          const confirmed = binding?.confirmed === true;
          if (confirmed) renders.add(file);
          const attrs = scanAstroAttributesWithOffsets(tag.attributes);
          const supplied = new Set<string>();
          let uncertain = false;
          for (const attr of attrs) {
            if (attr.kind === 'possible-binding') uncertain = true;
            else if (attr.name) supplied.add(normalizeProp(attr.name));
          }
          if (confirmed) {
            for (const [name, entries] of omissions) {
              if (supplied.has(name)) continue;
              if (uncertain) indeterminate.set(name, indeterminate.get(name)! + 1);
              else entries.push({ file, sourceRef: { sha256: snapshot.sha256, startOffset: templateOffset + tag.start, endOffset: templateOffset + tag.end } });
            }
          }
          const resolution = confirmed ? 'resolved' : 'candidate';
          const reason = confirmed ? 'Explicit static frontmatter import resolves to the target.'
            : 'Unresolved import binding is not fully resolved to the target.';
          if (!confirmed) diagnostics.push({ file, code: 'PROP_IMPACT_CANDIDATE', reason: `${tag.name}: ${reason}` });
          const attrsStartOffset = templateOffset + tag.start + 1 + tag.name.length;
          for (const attr of attrs) {
            const sourceRef: SourceRef = { sha256: snapshot.sha256, startOffset: attrsStartOffset + attr.start, endOffset: attrsStartOffset + attr.end };
            if (attr.kind === 'possible-binding') {
              const entry: PropUsage = { file, tag: tag.name, kind: 'possible-binding', resolution: 'candidate',
                reason: 'Astro spread attribute {...props} may supply any target prop.', sourceRef };
              for (const values of usages.values()) values.push(entry);
            } else if (attr.name) {
              usages.get(normalizeProp(attr.name))?.push({ file, tag: tag.name, kind: 'attribute', resolution, reason, sourceRef });
            }
          }
        }
      } else {
        // JSX / TSX
        const uses = collectJsxComponentUses(file, content, await loadAliasConfig(file));
        const sf = parseTypeScript(file, content, ts.ScriptKind.TSX);

        const walkJsx = (node: ts.Node) => {
          if (ts.isJsxOpeningElement(node) || ts.isJsxSelfClosingElement(node)) {
            const tagName = node.tagName.getText(sf);
            const use = uses.get(node.getStart(sf));
            const confirmed = use?.target === target;
            const relevant = confirmed || (use && !use.bound && targetNames.has(tagName.toLowerCase()));
            if (relevant) {
              if (confirmed) renders.add(file);

              const supplied = new Set<string>();
              let uncertain = false;

              for (const prop of node.attributes.properties) {
                if (ts.isJsxAttribute(prop)) {
                  supplied.add(normalizeProp(prop.name.getText(sf)));
                } else if (ts.isJsxSpreadAttribute(prop)) {
                  uncertain = true;
                }
              }

              if (confirmed) {
                for (const [name, entries] of omissions) {
                  if (supplied.has(name)) continue;
                  if (uncertain) indeterminate.set(name, indeterminate.get(name)! + 1);
                  else entries.push({ file, sourceRef: { sha256: snapshot.sha256, startOffset: node.getStart(sf), endOffset: node.getEnd() } });
                }
              }

              const resolution = confirmed ? 'resolved' : 'candidate';
              const reason = confirmed ? 'Explicit static import resolves to the target.'
                : 'Runtime registration or import binding is not fully resolved to the target.';

              for (const prop of node.attributes.properties) {
                if (ts.isJsxAttribute(prop)) {
                  const attrName = prop.name.getText(sf);
                  const norm = normalizeProp(attrName);
                  const entry: PropUsage = {
                    file,
                    tag: tagName,
                    kind: 'attribute',
                    resolution,
                    reason,
                    sourceRef: {
                      sha256: snapshot.sha256,
                      startOffset: prop.getStart(sf),
                      endOffset: prop.getEnd(),
                    },
                  };
                  usages.get(norm)?.push(entry);
                } else if (ts.isJsxSpreadAttribute(prop)) {
                  const entry: PropUsage = {
                    file,
                    tag: tagName,
                    kind: 'possible-binding',
                    resolution: 'candidate',
                    reason: 'JSX spread attribute {...props} may supply any target prop.',
                    sourceRef: {
                      sha256: snapshot.sha256,
                      startOffset: prop.getStart(sf),
                      endOffset: prop.getEnd(),
                    },
                  };
                  for (const values of usages.values()) values.push(entry);
                }
              }
            }
          }
          ts.forEachChild(node, walkJsx);
        };
        walkJsx(sf);
      }
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
