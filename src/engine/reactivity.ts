import { readSourceFile } from './source-file';
import { findProjectRoot } from './path-resolver';
import { getProjectEcosystem } from './framework-detector';
import { promises as fs } from 'node:fs';
import { resolve } from 'node:path';
import { discoverNuxtAutoImports } from './nuxt-auto-imports';
import {
  parse as parseDom,
  NodeTypes,
  type RootNode,
  type TemplateChildNode,
  type ElementNode,
  type DirectiveNode,
} from '@vue/compiler-dom';
import { compileScript } from '@vue/compiler-sfc';
import { parseVueSource as parseSfcRaw } from './vue-parser';
import { parseSfc } from './splitter';
import { remapPosition } from './remapper';
import { executeAstGrep } from './astgrep';
import { extractBoundaryContracts } from './contract';
import type {
  AuditEventHandlersOptions,
  BoundaryContract,
  DeadHandlerInfo,
  EventHandlerAuditResult,
  EventHandlerInfo,
} from '../types';

const BUILTIN_GLOBALS = new Set([
  '$emit',
  '$event',
  '$props',
  '$attrs',
  '$slots',
  '$refs',
  '$parent',
  '$root',
  'console',
  'window',
  'document',
  'Boolean',
  'Number',
  'String',
  'Array',
  'Object',
  'Math',
  'Date',
  'true',
  'false',
  'null',
  'undefined',
]);

const NUXT_AUTO_IMPORTS = new Set([
  'navigateTo',
  'refreshNuxtData',
  'abortNavigation',
  'clearError',
  'createError',
  'showError',
  'reloadNuxtApp',
  'useFetch',
  'useLazyFetch',
  'useAsyncData',
  'useLazyAsyncData',
  'useRoute',
  'useRouter',
  'useState',
  'useCookie',
  'useHead',
  'useSeoMeta',
  'useRuntimeConfig',
  'useNuxtApp',
  'useRequestHeaders',
  'useRequestEvent',
  'setResponseStatus',
  'definePageMeta',
  'defineNuxtComponent',
  'defineNuxtPlugin',
  'defineNuxtRouteMiddleware',
  'onNuxtReady',
  'callOnce',
]);

const INLINE_OP_REGEX = /(?:=|\+\+|--|\+=|-=|\bemit\s*\(|\$emit\s*\()/;

/**
 * Extracts the primary callee / identifier from an event expression.
 * e.g.:
 * - "handleSubmit" -> { identifier: "handleSubmit", isInline: false }
 * - "handleSubmit($event)" -> { identifier: "handleSubmit", isInline: false }
 * - "items.push(item)" -> { identifier: "items", isInline: false }
 * - "count++" -> { identifier: "count", isInline: true }
 * - "isOpen = !isOpen" -> { identifier: "isOpen", isInline: true }
 */
export function analyzeEventExpression(exp: string): {
  identifier: string;
  isInline: boolean;
} {
  const trimmed = exp.trim();
  if (!trimmed) {
    return { identifier: '', isInline: false };
  }

  // Detect direct inline mutations/assignments
  if (INLINE_OP_REGEX.test(trimmed) && !trimmed.startsWith('() =>') && !trimmed.startsWith('function')) {
    // If it's an assignment or increment, e.g. count++ or isOpen = true
    const identMatch = trimmed.match(/^([A-Za-z0-9_$]+)/);
    return {
      identifier: identMatch ? identMatch[1] : trimmed,
      isInline: true,
    };
  }

  // Arrow function wrapper, e.g. () => handleClick(item)
  if (/^\(\s*[^)]*\)\s*=>/.test(trimmed)) {
    const body = trimmed.replace(/^\(\s*[^)]*\)\s*=>\s*/, '').trim();
    return analyzeEventExpression(body);
  }

  // Function call with parens, e.g. handleClick(1, 2) or modal.open()
  const callMatch = trimmed.match(/^([A-Za-z0-9_$]+)(?:\.[A-Za-z0-9_$]+)*\s*(?:\(|$)/);
  if (callMatch) {
    const ident = callMatch[1];
    return {
      identifier: ident,
      isInline: false,
    };
  }

  return { identifier: trimmed, isInline: false };
}

/**
 * Audits event handlers in a Vue Single-File Component (SFC), cross-referencing
 * template event bindings (@click, v-on:) with script declarations.
 */
export async function auditEventHandlers(
  options: AuditEventHandlersOptions
): Promise<EventHandlerAuditResult> {
  const targetFile = resolve(options.path);
  let fileContent: string;
  if (options.code !== undefined) {
    fileContent = options.code;
  } else {
    try {
      fileContent = await readSourceFile(targetFile);
    } catch {
      throw new Error(`Failed to read component file: ${targetFile}`);
    }
  }

  const sfc = parseSfc(fileContent, targetFile);
  if (!sfc.template) {
    return {
      filePath: targetFile,
      totalEventBindings: 0,
      validHandlers: [],
      brokenHandlers: [],
      inlineExpressions: [],
      deadScriptHandlers: [],
    };
  }

  // 1. Gather all in-scope identifiers in <script> and <script setup>
  const definedIdentifiers = new Set<string>(BUILTIN_GLOBALS);
  const scriptDeclaredFunctions = new Map<string, { line: number; kind: 'function' | 'const'; body?: string }>();

  // Use @vue/compiler-sfc compileScript if scriptSetup or script is present
  try {
    const { descriptor } = parseSfcRaw(fileContent, { filename: targetFile });
    if (descriptor.script || descriptor.scriptSetup) {
      const compiled = compileScript(descriptor, { id: 'audit-' + Math.random().toString(36).slice(2) });
      if (compiled.bindings) {
        for (const [key, bindingType] of Object.entries(compiled.bindings)) {
          definedIdentifiers.add(key);
        }
      }
    }
  } catch {
    // If compileScript fails (e.g. syntax error or partial code), fallback to AST grep scanning
  }

  // 2. Scan script blocks for declared functions/constants and their line numbers
  const scriptBlocks = [sfc.scriptSetup, sfc.script].filter(Boolean);
  for (const block of scriptBlocks) {
    if (!block) continue;
    const blockStart = block.loc.start;
    const lang = block.lang || 'ts';

    // Query function declarations
    try {
      const fnMatches = await executeAstGrep({
        rule: `id: fn-decl\nlanguage: ${lang === 'js' ? 'js' : 'ts'}\nrule:\n  kind: function_declaration`,
        code: block.content,
        language: lang === 'js' ? 'js' : 'ts',
      });
      for (const m of fnMatches) {
        const nameMatch = m.text.match(/function\s+([A-Za-z0-9_$]+)/);
        if (nameMatch) {
          const fnName = nameMatch[1];
          const pos = remapPosition(m.line, m.column, blockStart);
          definedIdentifiers.add(fnName);
          scriptDeclaredFunctions.set(fnName, { line: pos.line, kind: 'function', body: m.text });
        }
      }

      // Query const/let arrow functions or callbacks: `const foo = (...) => ...`
      const varMatches = await executeAstGrep({
        rule: `id: arrow-decl\nlanguage: ${lang === 'js' ? 'js' : 'ts'}\nrule:\n  kind: variable_declarator\n  has:\n    field: value\n    kind: arrow_function`,
        code: block.content,
        language: lang === 'js' ? 'js' : 'ts',
      });
      for (const m of varMatches) {
        const nameMatch = m.text.match(/^([A-Za-z0-9_$]+)\s*=/);
        if (nameMatch) {
          const varName = nameMatch[1];
          const pos = remapPosition(m.line, m.column, blockStart);
          definedIdentifiers.add(varName);
          scriptDeclaredFunctions.set(varName, { line: pos.line, kind: 'const', body: m.text });
        }
      }
    } catch {
      // AST grep fallback
    }
  }

  // 2b. 1-Hop Static Outbound API resolution for declared script functions
  const fnOutboundApis = new Map<string, BoundaryContract>();
  for (const [fnName, fnInfo] of scriptDeclaredFunctions.entries()) {
    if (fnInfo.body) {
      const apis = extractBoundaryContracts(fnInfo.body, 'vue');
      if (apis.length > 0) {
        fnOutboundApis.set(fnName, apis[0]);
      }
    }
  }

  // 3. Parse template AST and extract all event directives
  const templateBlock = sfc.template;
  let templateAst: RootNode;
  try {
    templateAst = parseDom(templateBlock.content);
  } catch {
    throw new Error(`Failed to parse template AST for ${targetFile}`);
  }

  const validHandlers: EventHandlerInfo[] = [];
  const brokenHandlers: EventHandlerInfo[] = [];
  const candidateHandlers: EventHandlerInfo[] = [];
  const inlineExpressions: EventHandlerInfo[] = [];
  const referencedIdentifiersInTemplate = new Set<string>();

  const projectRoot = findProjectRoot(targetFile);
  const eco = getProjectEcosystem(projectRoot);
  const autoImports = eco.hasNuxt ? await discoverNuxtAutoImports(projectRoot) : null;

  function isNuxtCandidate(ident: string): boolean {
    return !!autoImports?.enabled && (NUXT_AUTO_IMPORTS.has(ident) || autoImports.names.has(ident));
  }

  function walkTemplate(node: RootNode | TemplateChildNode): void {
    if (node.type === NodeTypes.ELEMENT) {
      const el = node as ElementNode;
      for (const prop of el.props) {
        if (prop.type === NodeTypes.DIRECTIVE && prop.name === 'on') {
          const dir = prop as DirectiveNode;
          const eventName = dir.arg && 'content' in dir.arg ? dir.arg.content : 'unknown';
          const modifierList = (dir.modifiers ?? [])
            .map((m: unknown) => {
              if (typeof m === 'string') return m;
              if (m && typeof m === 'object') {
                const node = m as { content?: string; name?: string };
                return node.content ?? node.name ?? '';
              }
              return '';
            })
            .filter(Boolean);
          const modifiers = modifierList.length ? `.${modifierList.join('.')}` : '';
          const fullEvent = `${eventName}${modifiers}`;
          const expContent = dir.exp && 'content' in dir.exp ? dir.exp.content.trim() : '';

          // Calculate exact line in original .vue file
          const relLine = dir.loc.start.line;
          const relCol = dir.loc.start.column;
          const absPos = remapPosition(relLine, relCol, templateBlock.loc.start);

          if (!expContent) {
            continue;
          }

          const analysis = analyzeEventExpression(expContent);
          const ident = analysis.identifier;
          if (ident) {
            referencedIdentifiersInTemplate.add(ident);
          }

          const outboundApi = fnOutboundApis.get(ident) ?? (extractBoundaryContracts(expContent, 'vue')[0] || undefined);
          if (analysis.isInline) {
            const inlineApis = extractBoundaryContracts(expContent, 'vue');
            inlineExpressions.push({
              event: fullEvent,
              handlerName: expContent,
              line: absPos.line,
              status: 'inline-expression',
              ...(inlineApis.length > 0 ? { outboundApi: inlineApis[0] } : {}),
            });
          } else if (definedIdentifiers.has(ident)) {
            validHandlers.push({
              event: fullEvent,
              handlerName: ident,
              line: absPos.line,
              status: 'valid',
              source: scriptDeclaredFunctions.has(ident) ? 'local-function' : 'import',
              ...(outboundApi ? { outboundApi } : {}),
            });
          } else if (isNuxtCandidate(ident)) {
            candidateHandlers.push({
              event: fullEvent,
              handlerName: ident,
              line: absPos.line,
              status: 'candidate',
              source: 'nuxt-auto-import',
              evidence: {
                basis: 'derived',
                resolution: 'candidate',
                method: 'nuxt-auto-import',
              },
              ...(outboundApi ? { outboundApi } : {}),
            });
          } else {
            brokenHandlers.push({
              event: fullEvent,
              handlerName: ident,
              line: absPos.line,
              status: 'broken',
              source: 'unresolved',
            });
          }
        }

        // Two-way binding: v-model and v-model:argument
        if (prop.type === NodeTypes.DIRECTIVE && prop.name === 'model') {
          const dir = prop as DirectiveNode;
          const modelArg = dir.arg && 'content' in dir.arg ? dir.arg.content : 'modelValue';
          const fullEvent = `v-model${modelArg === 'modelValue' ? '' : `:${modelArg}`}`;
          const expContent = dir.exp && 'content' in dir.exp ? dir.exp.content.trim() : '';

          const relLine = dir.loc.start.line;
          const relCol = dir.loc.start.column;
          const absPos = remapPosition(relLine, relCol, templateBlock.loc.start);

          if (expContent) {
            const analysis = analyzeEventExpression(expContent);
            const ident = analysis.identifier;
            if (ident) {
              referencedIdentifiersInTemplate.add(ident);
            }

            if (definedIdentifiers.has(ident)) {
              validHandlers.push({
                event: fullEvent,
                handlerName: ident,
                line: absPos.line,
                status: 'valid',
                source: scriptDeclaredFunctions.has(ident) ? 'local-function' : 'import',
              });
            } else if (isNuxtCandidate(ident)) {
              candidateHandlers.push({
                event: fullEvent,
                handlerName: ident || expContent,
                line: absPos.line,
                status: 'candidate',
                source: 'nuxt-auto-import',
                evidence: {
                  basis: 'derived',
                  resolution: 'candidate',
                  method: 'nuxt-auto-import',
                },
              });
            } else {
              brokenHandlers.push({
                event: fullEvent,
                handlerName: ident || expContent,
                line: absPos.line,
                status: 'broken',
                source: 'unresolved',
              });
            }
          }
        }
      }
    }

    if ('children' in node && Array.isArray(node.children)) {
      for (const child of node.children) {
        walkTemplate(child as TemplateChildNode);
      }
    }
  }

  walkTemplate(templateAst);

  // 4. Identify dead script handlers: functions declared in script that look like handlers or helper methods
  // but are never called or referenced in the template or other parts of the script
  const deadScriptHandlers: DeadHandlerInfo[] = [];
  const scriptContent = [sfc.scriptSetup?.content, sfc.script?.content].filter(Boolean).join('\n');

  for (const [fnName, meta] of scriptDeclaredFunctions.entries()) {
    // If not referenced in template
    if (!referencedIdentifiersInTemplate.has(fnName)) {
      // Check if it is referenced elsewhere in script (e.g. called inside onMounted or another function)
      const refCount = (scriptContent.match(new RegExp(`\\b${fnName}\\b`, 'g')) || []).length;
      // If refCount <= 1, it is only mentioned at its declaration site!
      if (refCount <= 1) {
        deadScriptHandlers.push({
          name: fnName,
          line: meta.line,
          kind: meta.kind,
          hint: `Function '${fnName}' is declared in script but never used in template event bindings or lifecycle hooks`,
        });
      }
    }
  }

  const totalEventBindings =
    validHandlers.length + brokenHandlers.length + inlineExpressions.length + candidateHandlers.length;

  return {
    filePath: targetFile,
    totalEventBindings,
    validHandlers,
    brokenHandlers,
    inlineExpressions,
    ...(candidateHandlers.length > 0 ? { candidateHandlers } : {}),
    ...(autoImports?.unresolved.length ? { autoImportUnresolved: autoImports.unresolved } : {}),
    ...(autoImports?.dependencies.length ? { autoImportDependencies: autoImports.dependencies } : {}),
    deadScriptHandlers,
  };
}

/**
 * Formats EventHandlerAuditResult as clean, token-efficient markdown.
 */
export function formatEventHandlerAuditAsText(result: EventHandlerAuditResult): string {
  const lines: string[] = [];
  lines.push(`### Event Handler Audit: \`${result.filePath}\``);
  lines.push(`**Total Event Bindings:** ${result.totalEventBindings}\n`);
  if (result.autoImportUnresolved?.length) {
    lines.push('Nuxt auto-import discovery is partial; unresolved handlers do not prove application build failure.');
    for (const reason of result.autoImportUnresolved) lines.push(`- ${reason}`);
  }

  if (result.brokenHandlers.length > 0) {
    lines.push(`⚠️ **BROKEN EVENT HANDLERS (${result.brokenHandlers.length}):**`);
    for (const bh of result.brokenHandlers) {
      lines.push(`- Line ${bh.line}: \`@${bh.event}="${bh.handlerName}"\` — ❌ Handler '${bh.handlerName}' is not defined in script or imports!`);
    }
    lines.push('');
  } else {
    lines.push('✅ **No broken event handlers detected.**\n');
  }

  if (result.candidateHandlers && result.candidateHandlers.length > 0) {
    lines.push(`ℹ️ **AUTO-IMPORTED / CANDIDATE HANDLERS (${result.candidateHandlers.length}):**`);
    for (const ch of result.candidateHandlers) {
      const apiInfo = ch.outboundApi
        ? ` -> [${ch.outboundApi.boundaryType}] ${ch.outboundApi.method} ${ch.outboundApi.targetEndpoint}${
            ch.outboundApi.backendTargetHint
              ? ` -> [Backend: ${ch.outboundApi.backendTargetHint.suggestedSymbols[0] ?? ch.outboundApi.backendTargetHint.targetIntent}]`
              : ''
          }`
        : '';
      lines.push(`- Line ${ch.line}: \`@${ch.event}="${ch.handlerName}"\` — ℹ️ Candidate auto-import [${ch.source || 'nuxt-auto-import'}]${apiInfo}`);
    }
    lines.push('');
  }

  if (result.deadScriptHandlers.length > 0) {
    lines.push(`ℹ️ **DEAD SCRIPT HANDLERS (${result.deadScriptHandlers.length}):**`);
    for (const dh of result.deadScriptHandlers) {
      lines.push(`- Line ${dh.line}: \`${dh.name}\` (${dh.kind}) — ${dh.hint}`);
    }
    lines.push('');
  }

  if (result.validHandlers.length > 0) {
    lines.push(`**Valid Handlers (${result.validHandlers.length}):**`);
    for (const vh of result.validHandlers) {
      const apiInfo = vh.outboundApi
        ? ` -> [${vh.outboundApi.boundaryType}] ${vh.outboundApi.method} ${vh.outboundApi.targetEndpoint}${
            vh.outboundApi.backendTargetHint
              ? ` -> [Backend: ${vh.outboundApi.backendTargetHint.suggestedSymbols[0] ?? vh.outboundApi.backendTargetHint.targetIntent}]`
              : ''
          }`
        : '';
      lines.push(`- Line ${vh.line}: \`@${vh.event}="${vh.handlerName}"\` (source: ${vh.source || 'resolved'})${apiInfo}`);
    }
    lines.push('');
  }

  if (result.inlineExpressions.length > 0) {
    lines.push(`**Inline Expressions (${result.inlineExpressions.length}):**`);
    for (const ie of result.inlineExpressions) {
      const apiInfo = ie.outboundApi
        ? ` -> [${ie.outboundApi.boundaryType}] ${ie.outboundApi.method} ${ie.outboundApi.targetEndpoint}${
            ie.outboundApi.backendTargetHint
              ? ` -> [Backend: ${ie.outboundApi.backendTargetHint.suggestedSymbols[0] ?? ie.outboundApi.backendTargetHint.targetIntent}]`
              : ''
          }`
        : '';
      lines.push(`- Line ${ie.line}: \`@${ie.event}="${ie.handlerName}"\`${apiInfo}`);
    }
  }

  return lines.join('\n');
}

