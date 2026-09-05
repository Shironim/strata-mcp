import { promises as fs } from 'node:fs';
import { resolve } from 'node:path';
import {
  parse as parseDom,
  NodeTypes,
  type RootNode,
  type TemplateChildNode,
  type ElementNode,
  type DirectiveNode,
} from '@vue/compiler-dom';
import { parse as parseSfcRaw, compileScript } from '@vue/compiler-sfc';
import { parseSfc } from './splitter';
import { remapPosition } from './remapper';
import { executeAstGrep } from './astgrep';
import type {
  AuditEventHandlersOptions,
  DeadHandlerInfo,
  EventHandlerAuditResult,
  EventHandlerInfo,
  ReactivitySmell,
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
      fileContent = await fs.readFile(targetFile, 'utf8');
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
  const scriptDeclaredFunctions = new Map<string, { line: number; kind: 'function' | 'const' }>();

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
          scriptDeclaredFunctions.set(fnName, { line: pos.line, kind: 'function' });
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
          scriptDeclaredFunctions.set(varName, { line: pos.line, kind: 'const' });
        }
      }
    } catch {
      // AST grep fallback
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
  const inlineExpressions: EventHandlerInfo[] = [];
  const referencedIdentifiersInTemplate = new Set<string>();

  function walkTemplate(node: RootNode | TemplateChildNode): void {
    if (node.type === NodeTypes.ELEMENT) {
      const el = node as ElementNode;
      for (const prop of el.props) {
        if (prop.type === NodeTypes.DIRECTIVE && prop.name === 'on') {
          const dir = prop as DirectiveNode;
          const eventName = dir.arg && 'content' in dir.arg ? dir.arg.content : 'unknown';
          const modifierList = (dir.modifiers ?? [])
            .map((m: any) => (typeof m === 'string' ? m : m?.content ?? m?.name ?? ''))
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

          if (analysis.isInline) {
            inlineExpressions.push({
              event: fullEvent,
              handlerName: expContent,
              line: absPos.line,
              status: 'inline-expression',
            });
          } else if (definedIdentifiers.has(ident)) {
            validHandlers.push({
              event: fullEvent,
              handlerName: ident,
              line: absPos.line,
              status: 'valid',
              source: scriptDeclaredFunctions.has(ident) ? 'local-function' : 'import',
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

  const totalEventBindings = validHandlers.length + brokenHandlers.length + inlineExpressions.length;

  return {
    filePath: targetFile,
    totalEventBindings,
    validHandlers,
    brokenHandlers,
    inlineExpressions,
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

  if (result.brokenHandlers.length > 0) {
    lines.push(`⚠️ **BROKEN EVENT HANDLERS (${result.brokenHandlers.length}):**`);
    for (const bh of result.brokenHandlers) {
      lines.push(`- Line ${bh.line}: \`@${bh.event}="${bh.handlerName}"\` — ❌ Handler '${bh.handlerName}' is not defined in script or imports!`);
    }
    lines.push('');
  } else {
    lines.push('✅ **No broken event handlers detected.**\n');
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
      lines.push(`- Line ${vh.line}: \`@${vh.event}="${vh.handlerName}"\` (source: ${vh.source || 'resolved'})`);
    }
    lines.push('');
  }

  if (result.inlineExpressions.length > 0) {
    lines.push(`**Inline Expressions (${result.inlineExpressions.length}):**`);
    for (const ie of result.inlineExpressions) {
      lines.push(`- Line ${ie.line}: \`@${ie.event}="${ie.handlerName}"\``);
    }
  }

  return lines.join('\n');
}

export interface DetectReactivitySmellsOptions {
  path: string;
  code?: string;
}

/**
 * Detects anti-patterns and performance smells in reactivity architectures:
 * - Vue 3: Props destructuring losing reactivity, direct prop mutation via v-model or script
 * - React: Inline function/object allocation inside .map() render loops, missing useEffect deps
 */
export async function detectReactivitySmells(
  options: DetectReactivitySmellsOptions
): Promise<ReactivitySmell[]> {
  const smells: ReactivitySmell[] = [];
  const filePath = options.path;
  let code = options.code;

  if (!code) {
    try {
      code = await fs.readFile(filePath, 'utf8');
    } catch {
      return smells;
    }
  }

  const lines = code.split(/\r?\n/);
  const ext = filePath.split('.').pop()?.toLowerCase();

  // 1. Vue SFC Analysis
  if (ext === 'vue') {
    for (let i = 0; i < lines.length; i++) {
      const lineNum = i + 1;
      const line = lines[i];

      // Smell A: Destructuring defineProps directly (loses reactivity in Vue 3)
      const definePropsDestructMatch = line.match(/(?:const|let|var)\s*\{([^}]+)\}\s*=\s*defineProps/);
      if (definePropsDestructMatch) {
        const destructuredVars = definePropsDestructMatch[1].trim();
        smells.push({
          type: 'vue-props-destructure',
          severity: 'warning',
          message: `Destructuring '{ ${destructuredVars} }' directly from defineProps() causes loss of reactivity.`,
          line: lineNum,
          snippet: line.trim(),
          recommendation: `Access via props object (e.g. 'props.${destructuredVars.split(',')[0].trim()}') or use 'toRefs(props)' to preserve reactivity.`,
        });
      }

      // Smell B: Destructuring props object without toRefs
      if (
        /(?:const|let|var)\s*\{([^}]+)\}\s*=\s*props\b/.test(line) &&
        !line.includes('toRefs') &&
        !line.includes('storeToRefs')
      ) {
        const varsMatch = line.match(/(?:const|let|var)\s*\{([^}]+)\}\s*=\s*props\b/);
        const vars = varsMatch ? varsMatch[1].trim() : 'props';
        smells.push({
          type: 'vue-props-destructure',
          severity: 'warning',
          message: `Destructuring '{ ${vars} }' directly from 'props' loses reactivity.`,
          line: lineNum,
          snippet: line.trim(),
          recommendation: `Use 'const { ${vars} } = toRefs(props)' or reference 'props.${vars.split(',')[0].trim()}'.`,
        });
      }

      // Smell C: Direct prop mutation in template (v-model="props.xxx" or v-model="$props.xxx")
      const vModelPropMatch = line.match(/v-model(?::[A-Za-z0-9_-]+)?=["'](?:\$?props)\.([A-Za-z0-9_$.]+)["']/);
      if (vModelPropMatch) {
        const propName = vModelPropMatch[1];
        smells.push({
          type: 'vue-prop-mutation',
          severity: 'error',
          message: `Directly mutating prop via 'v-model="props.${propName}"' violates Vue's one-way data flow.`,
          line: lineNum,
          snippet: line.trim(),
          recommendation: `Emit an event (e.g. '@update:modelValue') or use 'defineModel()' / computed setter instead of mutating the prop.`,
        });
      }

      // Smell D: Direct prop mutation in script (props.foo = ... or $props.foo = ...)
      const scriptPropMutMatch = line.match(/(?:\bprops|\$props)\.([A-Za-z0-9_$]+)\s*(?:=|\+\+|--|\+=|-=)/);
      if (scriptPropMutMatch && !line.includes('defineProps') && !line.includes('==') && !line.includes('===')) {
        const propName = scriptPropMutMatch[1];
        smells.push({
          type: 'vue-prop-mutation',
          severity: 'error',
          message: `Direct mutation of prop '${propName}' in script violates one-way data flow.`,
          line: lineNum,
          snippet: line.trim(),
          recommendation: `Emit an event to the parent component rather than mutating the prop directly.`,
        });
      }
    }
  }

  // 2. React / JSX / TSX Analysis
  if (ext === 'jsx' || ext === 'tsx' || ext === 'js' || ext === 'ts') {
    let inMapBlock = false;
    let mapStartLine = 0;

    for (let i = 0; i < lines.length; i++) {
      const lineNum = i + 1;
      const line = lines[i];

      if (/\.(?:map|flatMap)\s*\(\s*(?:\([^)]*\)|[A-Za-z0-9_$]+)\s*=>/.test(line)) {
        inMapBlock = true;
        mapStartLine = lineNum;
      }

      if (inMapBlock) {
        // Smell A: Inline function handlers inside loop rendering custom components
        const inlineHandlerMatch = line.match(/<[A-Z][A-Za-z0-9_]*[^>]*?(?:on[A-Z][A-Za-z0-9]*)=\{(?:\([^)]*\)|[A-Za-z0-9_$]+)\s*=>/);
        if (inlineHandlerMatch) {
          smells.push({
            type: 'react-inline-in-loop',
            severity: 'warning',
            message: `Inline arrow function callback allocated inside .map() render loop causes unnecessary re-renders.`,
            line: lineNum,
            snippet: line.trim(),
            recommendation: `Extract item action handler, pass ID to child component callback, or wrap child in React.memo with useCallback.`,
          });
        }

        // Smell B: Inline object / style literal inside loop rendering custom components
        const inlineObjMatch = line.match(/<[A-Z][A-Za-z0-9_]*[^>]*?[a-zA-Z0-9_-]+=\{\{\s*[^}]+\s*\}\}/);
        if (inlineObjMatch) {
          smells.push({
            type: 'react-inline-in-loop',
            severity: 'warning',
            message: `Inline object literal passed as prop inside .map() loop creates new object references every render.`,
            line: lineNum,
            snippet: line.trim(),
            recommendation: `Hoist static style/config objects outside the render loop or memoize.`,
          });
        }

        if (lineNum > mapStartLine + 30 || (line.includes(');') && inMapBlock)) {
          inMapBlock = false;
        }
      }

      // Smell C: useEffect hook without dependency array
      const useEffectNoDeps = line.match(/useEffect\s*\(\s*(?:\(\)\s*=>|function\s*\(\))\s*\{/);
      if (useEffectNoDeps && !line.includes(', [')) {
        const followingLines = lines.slice(i, Math.min(i + 15, lines.length)).join('\n');
        if (/\}\s*\)/.test(followingLines) && !/\}\s*,\s*\[/.test(followingLines)) {
          smells.push({
            type: 'general',
            severity: 'warning',
            message: `useEffect hook called without a dependency array runs on EVERY single render.`,
            line: lineNum,
            snippet: line.trim(),
            recommendation: `Add a dependency array '[]' or specify reactive dependencies.`,
          });
        }
      }
    }
  }

  return smells;
}

/**
 * Formats reactivity smells into a concise, readable diagnostic text block.
 */
export function formatReactivitySmellsAsText(smells: ReactivitySmell[]): string {
  if (!smells || smells.length === 0) {
    return '✅ No reactivity smells detected.';
  }

  const lines: string[] = [`Reactivity Smells (${smells.length} detected):`];
  for (const s of smells) {
    const icon = s.severity === 'error' ? '❌' : '⚠️';
    lines.push(`  ${icon} [${s.severity.toUpperCase()}] Line ${s.line}: ${s.message}`);
    if (s.snippet) {
      lines.push(`     Code: \`${s.snippet}\``);
    }
    lines.push(`     Fix: ${s.recommendation}`);
  }
  return lines.join('\n');
}

