import { basename } from "node:path";
import { parse as parseDom, NodeTypes, type ElementNode } from "@vue/compiler-dom";
import ts from "typescript";
import { parseSfc } from "../splitter";
import type { ContextDependencyNode } from "../../types";
import { walkVueDom } from "./ast-helpers";

/**
 * Extracts provide/inject (Vue) and Context Provider/useContext (React) nodes from component code.
 */
/**
 * Extracts provide/inject (Vue) and Context Provider/useContext (React) nodes from component code
 * using official AST traversals (TypeScript Compiler API for scripts/JSX and @vue/compiler-dom for templates).
 */
export function extractComponentContextNodes(
  filePath: string,
  content: string
): { providers: ContextDependencyNode[]; consumers: ContextDependencyNode[] } {
  const providers: ContextDependencyNode[] = [];
  const consumers: ContextDependencyNode[] = [];
  const component = basename(filePath);

  const getLineFromOffset = (offset: number) => {
    let line = 1;
    for (let i = 0; i < offset && i < content.length; i++) {
      if (content.charCodeAt(i) === 10) line++;
    }
    return line;
  };

  // Helper to extract argument text or identifier from TS AST node
  const extractArgText = (arg: ts.Node | undefined, sf: ts.SourceFile): string => {
    if (!arg) return '';
    if (ts.isStringLiteral(arg) || ts.isNoSubstitutionTemplateLiteral(arg)) {
      return arg.text;
    }
    if (ts.isIdentifier(arg)) {
      return arg.text;
    }
    return arg.getText(sf).replace(/^['"`]|['"`]$/g, '').trim();
  };

  // 1. Process script blocks using TypeScript AST
  const scriptBlocks: Array<{ code: string; lineOffset: number }> = [];
  let templateBlock: { code: string; lineOffset: number } | null = null;

  if (content.includes('<template') || content.includes('<script')) {
    try {
      const sfc = parseSfc(content, basename(filePath));
      if (sfc.scriptSetup) {
        scriptBlocks.push({
          code: sfc.scriptSetup.content,
          lineOffset: sfc.scriptSetup.loc.start.line - 1,
        });
      }
      if (sfc.script) {
        scriptBlocks.push({
          code: sfc.script.content,
          lineOffset: sfc.script.loc.start.line - 1,
        });
      }
      if (sfc.template) {
        templateBlock = {
          code: sfc.template.content,
          lineOffset: sfc.template.loc.start.line - 1,
        };
      }
    } catch {
      scriptBlocks.push({ code: content, lineOffset: 0 });
    }
  } else {
    scriptBlocks.push({ code: content, lineOffset: 0 });
  }

  for (const block of scriptBlocks) {
    try {
      const sourceFile = ts.createSourceFile(
        basename(filePath) || 'temp.tsx',
        block.code,
        ts.ScriptTarget.Latest,
        true,
        ts.ScriptKind.TSX
      );

      function visit(node: ts.Node) {
        // Vue provide(...) or Vue.provide(...)
        if (ts.isCallExpression(node)) {
          let isProvide = false;
          let isInject = false;
          let isUseContext = false;

          if (ts.isIdentifier(node.expression)) {
            const fn = node.expression.text;
            if (fn === 'provide') isProvide = true;
            else if (fn === 'inject') isInject = true;
            else if (fn === 'useContext') isUseContext = true;
          } else if (ts.isPropertyAccessExpression(node.expression)) {
            const fn = node.expression.name.text;
            if (fn === 'provide') isProvide = true;
            else if (fn === 'inject') isInject = true;
            else if (fn === 'useContext') isUseContext = true;
          }

          const { line } = sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile));
          const calculatedLine = line + 1 + block.lineOffset;

          if (isProvide && node.arguments.length >= 1) {
            const key = extractArgText(node.arguments[0], sourceFile);
            if (key) {
              const valueSnippet = node.arguments[1] ? node.arguments[1].getText(sourceFile).trim() : undefined;
              providers.push({
                key,
                type: 'vue-provide',
                component,
                filePath,
                line: calculatedLine,
                valueSnippet,
              });
            }
          } else if (isInject && node.arguments.length >= 1) {
            const key = extractArgText(node.arguments[0], sourceFile);
            if (key) {
              consumers.push({
                key,
                type: 'vue-inject',
                component,
                filePath,
                line: calculatedLine,
              });
            }
          } else if (isUseContext && node.arguments.length >= 1) {
            const rawKey = extractArgText(node.arguments[0], sourceFile);
            if (rawKey) {
              const key = rawKey.endsWith('Context') ? rawKey : `${rawKey}Context`;
              consumers.push({
                key,
                type: 'react-use-context',
                component,
                filePath,
                line: calculatedLine,
              });
            }
          }
        }

        // React <Context.Provider value={...}> in JSX
        if (ts.isJsxOpeningElement(node) || ts.isJsxSelfClosingElement(node)) {
          if (ts.isPropertyAccessExpression(node.tagName) && node.tagName.name.text === 'Provider') {
            const rawKey = node.tagName.expression.getText(sourceFile);
            const key = rawKey.endsWith('Context') ? rawKey : `${rawKey}Context`;
            let valueSnippet: string | undefined;

            for (const attr of node.attributes.properties) {
              if (ts.isJsxAttribute(attr) && attr.name.text === 'value' && attr.initializer) {
                if (ts.isJsxExpression(attr.initializer) && attr.initializer.expression) {
                  valueSnippet = attr.initializer.expression.getText(sourceFile).trim();
                } else {
                  valueSnippet = attr.initializer.getText(sourceFile).trim();
                }
              }
            }

            const { line } = sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile));
            const calculatedLine = line + 1 + block.lineOffset;

            providers.push({
              key,
              type: 'react-provider',
              component,
              filePath,
              line: calculatedLine,
              valueSnippet,
            });
          }
        }

        ts.forEachChild(node, visit);
      }

      visit(sourceFile);
    } catch {
      // Fallback if TS AST parse fails
    }
  }

  // 2. Process template block via @vue/compiler-dom
  if (templateBlock) {
    try {
      const ast = parseDom(templateBlock.code, { comments: false });
      walkVueDom(ast, (el) => {
        if (el.tag.endsWith('.Provider')) {
          const rawKey = el.tag.slice(0, -'.Provider'.length);
          const key = rawKey.endsWith('Context') ? rawKey : `${rawKey}Context`;
          let valueSnippet: string | undefined;

          for (const prop of el.props) {
            if (prop.type === NodeTypes.ATTRIBUTE && prop.name === 'value') {
              valueSnippet = prop.value ? `"${prop.value.content}"` : undefined;
            } else if (
              prop.type === NodeTypes.DIRECTIVE &&
              prop.name === 'bind' &&
              prop.arg &&
              'content' in prop.arg &&
              prop.arg.content === 'value' &&
              prop.exp &&
              'content' in prop.exp
            ) {
              valueSnippet = prop.exp.content.trim();
            }
          }

          const line = el.loc.start.line + templateBlock!.lineOffset;
          providers.push({
            key,
            type: 'react-provider',
            component,
            filePath,
            line,
            valueSnippet,
          });
        }
      });
    } catch {
      // Fall through to regex fallback
    }
  }

  // 3. Fallback regex for unstructured or incomplete code snippets if AST found nothing
  if (providers.length === 0 && consumers.length === 0) {
    // Vue provide: provide('key', val) or provide(KEY_SYM, val)
    const vueProvideRegex = /\bprovide\s*\(\s*(?:['"]([^'"]+)['"]|([A-Za-z0-9_$]+))\s*,\s*([^)]*)\)/g;
    for (const m of content.matchAll(vueProvideRegex)) {
      const key = m[1] || m[2];
      if (key) {
        providers.push({
          key,
          type: 'vue-provide',
          component,
          filePath,
          line: getLineFromOffset(m.index || 0),
          valueSnippet: m[3]?.trim(),
        });
      }
    }

    // Vue inject: inject('key') or inject(KEY_SYM)
    const vueInjectRegex = /\binject\s*(?:<[^>]+>)?\s*\(\s*(?:['"]([^'"]+)['"]|([A-Za-z0-9_$]+))\s*(?:,[^)]*)?\)/g;
    for (const m of content.matchAll(vueInjectRegex)) {
      const key = m[1] || m[2];
      if (key) {
        consumers.push({
          key,
          type: 'vue-inject',
          component,
          filePath,
          line: getLineFromOffset(m.index || 0),
        });
      }
    }

    // React <Context.Provider value={...}>
    const reactProviderRegex = /<([A-Za-z0-9_$]+?)(?:Context)?\.Provider\b(?:[^>]*?value=\{([^}]+)\})?/g;
    for (const m of content.matchAll(reactProviderRegex)) {
      const key = m[1].endsWith('Context') ? m[1] : `${m[1]}Context`;
      providers.push({
        key,
        type: 'react-provider',
        component,
        filePath,
        line: getLineFromOffset(m.index || 0),
        valueSnippet: m[2]?.trim(),
      });
    }

    // React useContext(Context)
    const reactUseContextRegex = /\buseContext\s*(?:<[^>]+>)?\s*\(\s*([A-Za-z0-9_$]+)\s*\)/g;
    for (const m of content.matchAll(reactUseContextRegex)) {
      const rawKey = m[1];
      const key = rawKey.endsWith('Context') ? rawKey : `${rawKey}Context`;
      consumers.push({
        key,
        type: 'react-use-context',
        component,
        filePath,
        line: getLineFromOffset(m.index || 0),
      });
    }
  }

  return { providers, consumers };
}
