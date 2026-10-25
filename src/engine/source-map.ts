import { extname } from 'node:path';
import ts from 'typescript';
import { NodeTypes, parse as parseVueTemplate } from '@vue/compiler-dom';
import { parse as parseSvelte } from 'svelte/compiler';
import { parseAstro } from './astro-sfc';
import { detectFrameworkWithEvidence } from './framework-detector';
import { getSourcePosition, readSourceSnapshot } from './source-file';
import { parseSfc } from './splitter';
import type { SfcBlock, SourceMapDiagnostic, SourceMapResult, SourceRegion, SourceSnapshot } from '../types';

function region(
  snapshot: SourceSnapshot,
  content: string,
  kind: string,
  startOffset: number,
  endOffset: number,
  name?: string,
  attributes?: Record<string, string | boolean>,
): SourceRegion {
  const start = getSourcePosition(content, startOffset);
  const end = getSourcePosition(content, endOffset);
  return {
    kind,
    ...(name ? { name } : {}),
    ...(attributes ? { attributes } : {}),
    span: { start, end },
    lineRange: startOffset === endOffset ? null : {
      startLine: start.line,
      endLine: Math.max(start.line, end.line - (end.column === 1 ? 1 : 0)),
    },
    ref: { sha256: snapshot.sha256, startOffset, endOffset },
    evidence: { basis: 'source', resolution: 'resolved', method: 'parser-span', refs: [{ sha256: snapshot.sha256, startOffset, endOffset }] },
  };
}

function attrs(value: Record<string, string | true> | undefined): Record<string, string | boolean> | undefined {
  if (!value) return undefined;
  return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, item === true ? true : String(item)]));
}

function declarationName(statement: ts.Statement): string | undefined {
  if (ts.isFunctionDeclaration(statement) || ts.isClassDeclaration(statement) ||
      ts.isInterfaceDeclaration(statement) || ts.isTypeAliasDeclaration(statement) ||
      ts.isEnumDeclaration(statement) || ts.isModuleDeclaration(statement)) {
    return statement.name?.text;
  }
  if (ts.isVariableStatement(statement)) {
    const first = statement.declarationList.declarations[0];
    return first && ts.isIdentifier(first.name) ? first.name.text : undefined;
  }
  return undefined;
}

function countJsxRegions(node: ts.Node, insideJsx = false): number {
  const isJsx = ts.isJsxElement(node) || ts.isJsxSelfClosingElement(node) || ts.isJsxFragment(node);
  if (isJsx && !insideJsx) return 1;
  let count = 0;
  ts.forEachChild(node, child => { count += countJsxRegions(child, insideJsx || isJsx); });
  return count;
}

function mapScriptBlock(snapshot: SourceSnapshot, content: string, block: SfcBlock, maxRegions: number): { regions: SourceRegion[]; diagnostics: SourceMapDiagnostic[]; totalRegions: number; returnedRegions: number; truncated: boolean; childRegionsTruncated: boolean } {
  const langAttr = block.attrs?.lang;
  const lang = typeof langAttr === 'string' ? langAttr : block.lang;
  const kind = /tsx/i.test(lang) ? ts.ScriptKind.TSX : /jsx/i.test(lang) ? ts.ScriptKind.JSX : /^(js|javascript|mjs|cjs)$/i.test(lang) ? ts.ScriptKind.JS : ts.ScriptKind.TS;
  const source = ts.createSourceFile(snapshot.file, block.content, ts.ScriptTarget.Latest, true, kind);
  let childRegionsTruncated = false;
  const regions = source.statements.slice(0, maxRegions).map(statement => {
    const item = region(snapshot, content, 'symbol', block.loc.start.offset + statement.getStart(source), block.loc.start.offset + statement.end, declarationName(statement));
    if (kind !== ts.ScriptKind.TSX && kind !== ts.ScriptKind.JSX) return item;
    const children: SourceRegion[] = [];
    const visit = (node: ts.Node, insideJsx: boolean): void => {
      const isJsx = ts.isJsxElement(node) || ts.isJsxSelfClosingElement(node) || ts.isJsxFragment(node);
      if (isJsx && !insideJsx) {
        children.push(region(snapshot, content, 'jsx', block.loc.start.offset + node.getStart(source), block.loc.start.offset + node.end));
        return;
      }
      ts.forEachChild(node, child => visit(child, insideJsx || isJsx));
    };
    visit(statement, false);
    if (children.length > 20) childRegionsTruncated = true;
    return children.length ? { ...item, children: children.slice(0, 20) } : item;
  });
  const diagnostics: SourceMapDiagnostic[] = (source as ts.SourceFile & { parseDiagnostics: readonly ts.Diagnostic[] }).parseDiagnostics.map(item => ({
    code: `TS_PARSE_${item.code}`,
    message: ts.flattenDiagnosticMessageText(item.messageText, '\n'),
    ...(item.start === undefined ? {} : { span: {
      start: getSourcePosition(content, block.loc.start.offset + item.start),
      end: getSourcePosition(content, block.loc.start.offset + item.start + (item.length ?? 0)),
    } }),
  }));
  const totalRegions = source.statements.length + source.statements.reduce((sum, statement) => sum + countJsxRegions(statement), 0);
  return {
    regions,
    diagnostics,
    totalRegions,
    returnedRegions: regions.length + regions.reduce((sum, item) => sum + (item.children?.length ?? 0), 0),
    truncated: source.statements.length > maxRegions,
    childRegionsTruncated,
  };
}

function mapVue(snapshot: SourceSnapshot, content: string, maxRegions: number): SourceMapResult {
  const parsed = parseSfc(content, snapshot.file);
  const blocks = [parsed.script, parsed.scriptSetup, parsed.template, ...parsed.styles, ...parsed.customBlocks]
    .filter((block): block is NonNullable<typeof block> => Boolean(block));
  let remaining = maxRegions;
  let truncated = false;
  let totalRegions = blocks.length;
  let returnedRegions = blocks.length;
  let childRegionsTruncated = false;
  const diagnostics: SourceMapDiagnostic[] = (parsed.diagnostics ?? []).map(item => ({ code: item.code, message: item.message }));
  const regions = blocks.map(block => {
    const item = region(
      snapshot, content, 'block', block.loc.start.offset, block.loc.end.offset, block.type,
      { ...(attrs(block.attrs) ?? {}), ...(block.scoped ? { scoped: true } : {}), ...(block.module ? { module: typeof block.module === 'string' ? block.module : true } : {}) },
    );
    if (block.attrs?.src) item.evidence = { ...item.evidence, resolution: 'unsupported', method: 'external-sfc-src', reason: 'External block contents are outside this file snapshot.' };
    if (block.type === 'script' || block.type === 'scriptSetup') {
      const mapped = mapScriptBlock(snapshot, content, block, remaining);
      remaining -= mapped.regions.length;
      truncated ||= mapped.truncated;
      totalRegions += mapped.totalRegions;
      returnedRegions += mapped.returnedRegions;
      childRegionsTruncated ||= mapped.childRegionsTruncated;
      diagnostics.push(...mapped.diagnostics);
      return { ...item, children: mapped.regions };
    }
    if (block.type === 'template') {
      try {
        const template = parseVueTemplate(block.content);
        const SEMANTIC_TAGS = new Set([
          'form', 'table', 'dialog', 'nav', 'header', 'footer', 'main', 'aside', 'section', 'article', 'modal'
        ]);

        function isSignificant(el: any): boolean {
          if (SEMANTIC_TAGS.has(String(el.tag).toLowerCase())) return true;
          if (/^[A-Z]/.test(el.tag)) return true;
          return el.props && el.props.some((p: any) => p.type === NodeTypes.DIRECTIVE && (p.name === 'for' || p.name === 'if' || p.name === 'model'));
        }

        function mapElementTree(el: any, depth = 0): SourceRegion {
          const regionAttributes: Record<string, string | boolean> = {};
          if (el.props) {
            const forDir = el.props.find((p: any) => p.type === NodeTypes.DIRECTIVE && p.name === 'for');
            if (forDir && forDir.exp) {
              regionAttributes['v-for'] = forDir.exp.content || true;
            }
            const ifDir = el.props.find((p: any) => p.type === NodeTypes.DIRECTIVE && p.name === 'if');
            if (ifDir && ifDir.exp) {
              regionAttributes['v-if'] = ifDir.exp.content || true;
            }
          }

          const elemRegion = region(
            snapshot,
            content,
            'template-region',
            block.loc.start.offset + el.loc.start.offset,
            block.loc.start.offset + el.loc.end.offset,
            el.tag,
            Object.keys(regionAttributes).length ? regionAttributes : undefined
          );

          if (depth < 3 && el.children && el.children.length > 0) {
            const childElements = el.children.filter((c: any) => c.type === NodeTypes.ELEMENT);
            const significantChildren = childElements.filter(isSignificant);
            if (significantChildren.length > 0) {
              elemRegion.children = significantChildren.slice(0, 10).map((c: any) => mapElementTree(c, depth + 1));
            }
          }

          return elemRegion;
        }

        const elements = template.children.filter(child => child.type === NodeTypes.ELEMENT);
        totalRegions += elements.length;
        item.children = elements.slice(0, maxRegions).map(child => mapElementTree(child));
        returnedRegions += item.children.length;
        if (elements.length > maxRegions) {
          truncated = true;
          childRegionsTruncated = true;
        }
        const parseErrors = (template as typeof template & { errors?: Array<{ code: number; message: string }> }).errors ?? [];
        for (const error of parseErrors) diagnostics.push({ code: `VUE_TEMPLATE_PARSE_${error.code}`, message: error.message });
      } catch (error) {
        diagnostics.push({ code: 'VUE_TEMPLATE_PARSE', message: error instanceof Error ? error.message : String(error) });
      }
    }
    return item;
  });
  truncated ||= remaining <= 0 && blocks.some(block => block.type === 'script' || block.type === 'scriptSetup');
  return {
    snapshot, documentType: 'vue', framework: 'vue',
    status: diagnostics.length || truncated ? 'partial' : 'complete', regions, diagnostics,
    supported: ['sfc-blocks', 'top-level-script-symbols', 'top-level-template-regions', 'absolute-lines', 'source-ref'],
    unsupported: ['external-block-content'],
    coverage: { totalRegions, returnedRegions, truncated, childRegionsTruncated },
  };
}

function mapAstro(snapshot: SourceSnapshot, content: string, maxRegions: number): SourceMapResult {
  const parsed = parseAstro(content, snapshot.file);
  const blocks: SfcBlock[] = [
    ...(parsed.frontmatter ? [parsed.frontmatter] : []),
    ...(parsed.template ? [parsed.template] : []),
    ...(parsed.scripts ?? []),
    ...(parsed.styles ?? []),
  ];
  const diagnostics: SourceMapDiagnostic[] = (parsed.diagnostics ?? []).map(item => ({ code: item.code, message: item.message }));
  let totalRegions = blocks.length;
  let returnedRegions = blocks.length;
  let truncated = false;
  let childRegionsTruncated = false;
  const regions = blocks.map(block => {
    let blockKind = 'block';
    if (block.type === 'frontmatter') blockKind = 'frontmatter';
    else if (block.type === 'astroTemplate') blockKind = 'template';
    else if (block.type === 'script') blockKind = 'script';
    else if (block.type === 'style') blockKind = 'style';

    const item = region(
      snapshot,
      content,
      blockKind,
      block.loc.start.offset,
      block.loc.end.offset,
      undefined,
      attrs(block.attrs)
    );

    if (block.type === 'frontmatter' || block.type === 'script') {
      const mapped = mapScriptBlock(snapshot, content, block, maxRegions);
      item.children = mapped.regions;
      diagnostics.push(...mapped.diagnostics);
      totalRegions += mapped.totalRegions;
      returnedRegions += mapped.returnedRegions;
      truncated ||= mapped.truncated;
      childRegionsTruncated ||= mapped.childRegionsTruncated;
      return item;
    }

    if (block.type === 'astroTemplate') {
      const templateChildren: SourceRegion[] = [];
      const templateStart = block.loc.start.offset;
      const templateText = block.content;

      // Extract islands: <ComponentName ... client:... /> or <ComponentName ... client:...>...</ComponentName>
      const islandRegex = /<([A-Z][A-Za-z0-9_.]*)\b([^>]*\bclient:(?:load|visible|idle|media|only)[^>]*)(\/?>)/g;
      let match: RegExpExecArray | null;
      while ((match = islandRegex.exec(templateText)) !== null) {
        const compName = match[1];
        const attrString = match[2];
        const isSelfClosing = match[3] === '/>';
        const startOffset = templateStart + match.index;
        let endOffset = startOffset + match[0].length;

        if (!isSelfClosing) {
          const closeTag = `</${compName}>`;
          const closeIndex = templateText.indexOf(closeTag, match.index + match[0].length);
          if (closeIndex !== -1) {
            endOffset = templateStart + closeIndex + closeTag.length;
          }
        }

        const directiveMatch = attrString.match(/\b(client:(?:load|visible|idle|media|only))(?:=(?:"([^"]*)"|'([^']*)'|\{([^}]*)\}|([^\s>]+)))?/);
        const directiveName = directiveMatch ? directiveMatch[1] : 'client:load';
        const directiveVal = directiveMatch ? (directiveMatch[2] ?? directiveMatch[3] ?? directiveMatch[4] ?? directiveMatch[5]) : undefined;

        const islandAttrs: Record<string, string | boolean> = {
          directive: directiveName,
          component: compName,
        };
        if (directiveVal !== undefined) {
          islandAttrs.directiveValue = directiveVal;
        }

        templateChildren.push(
          region(snapshot, content, 'island', startOffset, endOffset, compName, islandAttrs)
        );
      }

      // Extract slots: <slot ... /> or <slot ...>...</slot>
      const slotRegex = /<slot\b([^>]*)(\/?>)/g;
      while ((match = slotRegex.exec(templateText)) !== null) {
        const attrString = match[1];
        const isSelfClosing = match[2] === '/>';
        const startOffset = templateStart + match.index;
        let endOffset = startOffset + match[0].length;

        if (!isSelfClosing) {
          const closeTag = '</slot>';
          const closeIndex = templateText.indexOf(closeTag, match.index + match[0].length);
          if (closeIndex !== -1) {
            endOffset = templateStart + closeIndex + closeTag.length;
          }
        }

        const nameMatch = attrString.match(/\bname=(?:"([^"]*)"|'([^']*)'|\{([^}]*)\}|([^\s>]+))/);
        const slotName = nameMatch ? (nameMatch[1] ?? nameMatch[2] ?? nameMatch[3] ?? nameMatch[4]) : 'default';

        templateChildren.push(
          region(snapshot, content, 'slot', startOffset, endOffset, slotName, { name: slotName })
        );
      }

      templateChildren.sort((a, b) => a.span.start.offset - b.span.start.offset);

      totalRegions += templateChildren.length;
      if (templateChildren.length > maxRegions) {
        item.children = templateChildren.slice(0, maxRegions);
        truncated = true;
        childRegionsTruncated = true;
      } else if (templateChildren.length > 0) {
        item.children = templateChildren;
      }
      returnedRegions += item.children ? item.children.length : 0;
    }

    return item;
  });

  return {
    snapshot,
    documentType: 'astro',
    framework: 'astro',
    status: diagnostics.length || truncated || childRegionsTruncated ? 'partial' : 'complete',
    regions,
    diagnostics,
    supported: ['frontmatter', 'frontmatter-symbols', 'template', 'embedded-scripts', 'embedded-styles', 'islands', 'slots', 'absolute-lines', 'source-ref'],
    unsupported: [],
    coverage: { totalRegions, returnedRegions, truncated, childRegionsTruncated },
  };
}

function mapScript(snapshot: SourceSnapshot, content: string, ext: string, maxRegions: number): SourceMapResult {
  const scriptKind = ext === '.tsx' ? ts.ScriptKind.TSX : ext === '.jsx' ? ts.ScriptKind.JSX : ['.js', '.mjs', '.cjs'].includes(ext) ? ts.ScriptKind.JS : ts.ScriptKind.TS;
  const source = ts.createSourceFile(snapshot.file, content, ts.ScriptTarget.Latest, true, scriptKind);
  let childRegionsTruncated = false;
  const regions: SourceRegion[] = source.statements.slice(0, maxRegions).map(statement => {
    const isImport = ts.isImportDeclaration(statement) || ts.isExportDeclaration(statement);
    const isType = ts.isInterfaceDeclaration(statement) || ts.isTypeAliasDeclaration(statement);
    const name = declarationName(statement);
    const isComponent = Boolean(name && /^[A-Z]/.test(name));
    const isCustomHook = Boolean(name && /^use[A-Z]/.test(name));
    const role = isType ? 'type-declaration' : isComponent ? 'component' : isCustomHook ? 'custom-hook' : undefined;

    const parent = region(
      snapshot,
      content,
      isImport ? 'import' : 'symbol',
      statement.getStart(source),
      statement.end,
      name,
      role ? { role } : undefined
    );
    if (!source.languageVariant || (scriptKind !== ts.ScriptKind.TSX && scriptKind !== ts.ScriptKind.JSX)) return parent;
    const childRegions: SourceRegion[] = [];
    const visit = (node: ts.Node, insideJsx: boolean): void => {
      const isJsx = ts.isJsxElement(node) || ts.isJsxSelfClosingElement(node) || ts.isJsxFragment(node);
      if (isJsx && !insideJsx) {
        childRegions.push(region(snapshot, content, 'jsx', node.getStart(source), node.end));
        return;
      }
      if (ts.isCallExpression(node)) {
        let hookName: string | undefined;
        if (ts.isIdentifier(node.expression)) {
          const text = node.expression.text;
          if (/^use[A-Z]/.test(text) || text === 'use') hookName = text;
        } else if (ts.isPropertyAccessExpression(node.expression) && ts.isIdentifier(node.expression.name)) {
          const text = node.expression.name.text;
          if (/^use[A-Z]/.test(text) || text === 'use') hookName = text;
        }
        if (hookName) {
          childRegions.push(region(snapshot, content, 'hook-call', node.getStart(source), node.end, hookName));
        }
      }
      ts.forEachChild(node, child => visit(child, insideJsx || isJsx));
    };
    visit(statement, false);
    if (childRegions.length > 30) childRegionsTruncated = true;
    const children = childRegions.sort((a, b) => a.ref.startOffset - b.ref.startOffset).slice(0, 30);
    return children.length ? { ...parent, children } : parent;
  });
  const totalJsxRegions = source.statements.reduce((sum, statement) => sum + countJsxRegions(statement), 0);
  const parseDiagnostics = (source as ts.SourceFile & { parseDiagnostics: readonly ts.Diagnostic[] }).parseDiagnostics;
  const diagnostics: SourceMapDiagnostic[] = parseDiagnostics.map(diagnostic => ({
    code: `TS_PARSE_${diagnostic.code}`,
    message: ts.flattenDiagnosticMessageText(diagnostic.messageText, '\n'),
    ...(diagnostic.start === undefined ? {} : {
      span: {
        start: getSourcePosition(content, diagnostic.start),
        end: getSourcePosition(content, diagnostic.start + (diagnostic.length ?? 0)),
      },
    }),
  }));
  const fwDetection = detectFrameworkWithEvidence(snapshot.file, content);
  const detectedFramework = fwDetection.framework === 'unknown' ? (ext === '.tsx' || ext === '.jsx' ? 'react' : 'script') : fwDetection.framework;
  const isJsx = ext === '.tsx' || ext === '.jsx';

  return {
    snapshot,
    documentType: isJsx ? 'jsx-module' : 'script-module',
    framework: detectedFramework,
    status: diagnostics.length || source.statements.length > maxRegions || childRegionsTruncated ? 'partial' : 'complete', regions, diagnostics,
    supported: ['top-level-imports-and-symbols', 'jsx-root-regions', 'absolute-lines', 'source-ref'],
    unsupported: ['nested-symbols', 'nested-jsx-regions'],
    coverage: {
      totalRegions: source.statements.length + totalJsxRegions,
      returnedRegions: regions.length + regions.reduce((sum, item) => sum + (item.children?.length ?? 0), 0),
      truncated: source.statements.length > maxRegions,
      childRegionsTruncated,
    },
  };
}

function mapSvelte(snapshot: SourceSnapshot, content: string, maxRegions: number): SourceMapResult {
  const diagnostics: SourceMapDiagnostic[] = [];
  const regions: SourceRegion[] = [];
  let remaining = maxRegions;
  let truncated = false;
  let childRegionsTruncated = false;
  let totalRegions = 0;
  let returnedRegions = 0;

  try {
    const ast = parseSvelte(content, { modern: true }) as any;

    // 1. Module Script
    if (ast.module) {
      const mod = ast.module;
      const scriptContent = mod.content?.body ? content.slice(mod.content.start, mod.content.end) : '';
      const langAttr = mod.attributes?.find((a: any) => a.name === 'lang');
      const lang = langAttr?.value?.[0]?.data || 'js';
      const block: SfcBlock = {
        type: 'script',
        content: scriptContent,
        lang,
        loc: {
          start: getSourcePosition(content, mod.start),
          end: getSourcePosition(content, mod.end),
        },
        module: true,
      };
      const blockRegion = region(snapshot, content, 'block', mod.start, mod.end, 'script', { module: true });
      totalRegions++;
      returnedRegions++;
      const mapped = mapScriptBlock(snapshot, content, block, remaining);
      remaining -= mapped.regions.length;
      truncated ||= mapped.truncated;
      totalRegions += mapped.totalRegions;
      returnedRegions += mapped.returnedRegions;
      childRegionsTruncated ||= mapped.childRegionsTruncated;
      diagnostics.push(...mapped.diagnostics);
      blockRegion.children = mapped.regions;
      regions.push(blockRegion);
    }

    // 2. Instance Script
    if (ast.instance) {
      const inst = ast.instance;
      const scriptContent = inst.content?.body ? content.slice(inst.content.start, inst.content.end) : '';
      const langAttr = inst.attributes?.find((a: any) => a.name === 'lang');
      const lang = langAttr?.value?.[0]?.data || 'js';
      const block: SfcBlock = {
        type: 'scriptSetup',
        content: scriptContent,
        lang,
        loc: {
          start: getSourcePosition(content, inst.start),
          end: getSourcePosition(content, inst.end),
        },
      };
      const blockRegion = region(snapshot, content, 'block', inst.start, inst.end, 'script');
      totalRegions++;
      returnedRegions++;
      const mapped = mapScriptBlock(snapshot, content, block, remaining);
      remaining -= mapped.regions.length;
      truncated ||= mapped.truncated;
      totalRegions += mapped.totalRegions;
      returnedRegions += mapped.returnedRegions;
      childRegionsTruncated ||= mapped.childRegionsTruncated;
      diagnostics.push(...mapped.diagnostics);
      blockRegion.children = mapped.regions;
      regions.push(blockRegion);
    }

    // 3. Fragment / Template
    if (ast.fragment && ast.fragment.nodes?.length > 0) {
      const nodes = ast.fragment.nodes.filter((n: any) => n.type !== 'Text' || n.data?.trim().length > 0);
      const first = ast.fragment.nodes[0];
      const last = ast.fragment.nodes[ast.fragment.nodes.length - 1];
      const templateRegion = region(snapshot, content, 'block', first.start, last.end, 'template');
      totalRegions++;
      returnedRegions++;

      function collectElements(parentNodes: any[]): any[] {
        const result: any[] = [];
        for (const n of parentNodes) {
          if (n.type === 'RegularElement' || n.type === 'Component' || n.type === 'SvelteComponent' || n.type === 'SnippetBlock') {
            result.push(n);
            if (n.fragment?.nodes) {
              result.push(...collectElements(n.fragment.nodes));
            }
          }
        }
        return result;
      }

      const allElements = collectElements(ast.fragment.nodes);
      const templateChildren: SourceRegion[] = [];
      for (const node of allElements) {
        if (templateChildren.length >= remaining) {
          truncated = true;
          childRegionsTruncated = true;
          break;
        }
        if (node.type === 'RegularElement' || node.type === 'Component' || node.type === 'SvelteComponent') {
          templateChildren.push(region(snapshot, content, 'template-region', node.start, node.end, node.name));
        } else if (node.type === 'SnippetBlock') {
          templateChildren.push(region(snapshot, content, 'template-region', node.start, node.end, `snippet:${node.expression?.name || 'anonymous'}`));
        }
      }
      totalRegions += allElements.length;
      returnedRegions += templateChildren.length;
      remaining -= templateChildren.length;
      if (templateChildren.length > 0) {
        templateRegion.children = templateChildren;
      }
      regions.push(templateRegion);
    }

    // 4. Style
    if (ast.css) {
      const css = ast.css;
      const styleRegion = region(snapshot, content, 'block', css.start, css.end, 'style');
      totalRegions++;
      returnedRegions++;
      regions.push(styleRegion);
    }
  } catch (error) {
    diagnostics.push({
      code: 'SVELTE_PARSE_ERROR',
      message: error instanceof Error ? error.message : String(error),
    });
  }

  return {
    snapshot,
    documentType: 'svelte-sfc',
    framework: 'svelte',
    status: diagnostics.length || truncated || childRegionsTruncated ? 'partial' : 'complete',
    regions,
    diagnostics,
    supported: ['script-blocks', 'template-elements', 'style-block', 'source-ref'],
    unsupported: ['css-selectors', 'nested-each-blocks'],
    coverage: {
      totalRegions,
      returnedRegions,
      truncated,
      childRegionsTruncated,
    },
  };
}

export async function mapSourceFile(path: string, options: { maxRegions?: number } = {}): Promise<SourceMapResult> {
  const { snapshot, content } = await readSourceSnapshot(path);
  const ext = extname(snapshot.file).toLowerCase();
  const maxRegions = Math.min(500, Math.max(1, options.maxRegions ?? 200));
  if (ext === '.vue') return mapVue(snapshot, content, maxRegions);
  if (ext === '.astro') return mapAstro(snapshot, content, maxRegions);
  if (ext === '.svelte') return mapSvelte(snapshot, content, maxRegions);
  return mapScript(snapshot, content, ext, maxRegions);
}
