import ts from 'typescript';
import type { CodePatternDiagnostic, SourceSnapshot } from '../../types';
import { parseAstro } from '../astro-sfc';
import type { CanonAuditOptions } from './types';
import { createDiagnostic } from './types';

const BROWSER_GLOBALS = new Set([
  'window',
  'document',
  'localStorage',
  'sessionStorage',
  'navigator',
  'location',
  'history',
]);

/**
 * Astro Canonical Pattern Rules:
 * 1. astro/interactive-component-missing-client-directive (warning)
 * 2. astro/over-hydration-client-load (warning)
 * 3. astro/client-only-missing-framework-hint (error)
 * 4. astro/no-browser-globals-in-frontmatter (error)
 * 5. astro/no-function-props-to-island (error)
 * 6. astro/define-vars-forces-inline-script (error)
 */
export async function checkAstroRules(
  snapshot: SourceSnapshot,
  content: string,
  options?: CanonAuditOptions
): Promise<CodePatternDiagnostic[]> {
  const diagnostics: CodePatternDiagnostic[] = [];
  const descriptor = parseAstro(content, snapshot.file);

  const importedFrameworkComponents = new Map<string, string>(); // ComponentName -> import path
  const declaredFunctionsInFm = new Set<string>();

  // =========================================================================
  // 1. Analyze Frontmatter AST
  // =========================================================================
  if (descriptor.frontmatter) {
    const fmContent = descriptor.frontmatter.content;
    const fmStartOffset = descriptor.frontmatter.loc.start.offset;
    const sf = ts.createSourceFile('frontmatter.ts', fmContent, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);

    const visit = (node: ts.Node) => {
      // Record imports to distinguish Astro components vs framework islands (React/Vue/Svelte)
      if (ts.isImportDeclaration(node) && node.importClause && ts.isStringLiteral(node.moduleSpecifier)) {
        const importPath = node.moduleSpecifier.text;
        if (node.importClause.name) {
          importedFrameworkComponents.set(node.importClause.name.text, importPath);
        }
        if (node.importClause.namedBindings && ts.isNamedImports(node.importClause.namedBindings)) {
          for (const spec of node.importClause.namedBindings.elements) {
            importedFrameworkComponents.set(spec.name.text, importPath);
          }
        }
      }

      // Record function declarations in frontmatter
      if (ts.isFunctionDeclaration(node) && node.name) {
        declaredFunctionsInFm.add(node.name.text);
      }
      if (ts.isVariableStatement(node)) {
        for (const decl of node.declarationList.declarations) {
          if (ts.isIdentifier(decl.name) && decl.initializer && (ts.isArrowFunction(decl.initializer) || ts.isFunctionExpression(decl.initializer))) {
            declaredFunctionsInFm.add(decl.name.text);
          }
        }
      }

      // Rule: astro/no-browser-globals-in-frontmatter
      if (ts.isIdentifier(node) && BROWSER_GLOBALS.has(node.text)) {
        // Exclude type declarations or member property names
        let isValueAccess = true;
        if (node.parent) {
          if (ts.isPropertySignature(node.parent) || ts.isTypeReferenceNode(node.parent)) {
            isValueAccess = false;
          }
          if (ts.isPropertyAccessExpression(node.parent) && node.parent.name === node) {
            // e.g. foo.window
            isValueAccess = false;
          }
          if (ts.isTypeOfExpression(node.parent)) {
            // typeof window is often a safe check: typeof window !== 'undefined'
            isValueAccess = false;
          }
        }

        if (isValueAccess) {
          const startOffset = fmStartOffset + node.getStart(sf);
          const endOffset = fmStartOffset + node.end;
          diagnostics.push(
            createDiagnostic({
              ruleId: 'astro/no-browser-globals-in-frontmatter',
              framework: 'astro',
              category: 'boundary',
              severity: 'error',
              snapshot,
              content,
              startOffset,
              endOffset,
              smellTitle: `Browser Global '${node.text}' Accessed in Server Frontmatter`,
              smellExplanation: `Astro frontmatter runs exclusively on the server (SSG/SSR) and is never sent to the browser. Accessing browser global '${node.text}' will cause a ReferenceError at runtime.`,
              canonSummary: `Move browser API access into a client-side <script> tag in the template or inside an interactive island component lifecycle.`,
              canonRationale: 'Astro components execute entirely on the server unless hydrated via client scripts or framework islands.',
              canonicalCode: `// Move to <script>\n<script>\n  const value = ${node.text};\n</script>`,
              referenceDoc: 'https://docs.astro.build/en/guides/troubleshooting/#window-or-document-is-not-defined',
            })
          );
        }
      }

      ts.forEachChild(node, visit);
    };

    visit(sf);
  }

  // =========================================================================
  // 2. Analyze Template: Islands, Directives, and Event Handlers
  // =========================================================================
  if (descriptor.template) {
    const tmplText = descriptor.template.content;
    const tmplStart = descriptor.template.loc.start.offset;

    // Track footer range for over-hydration rule
    const footerMatch = tmplText.match(/<footer\b[\s\S]*?<\/footer>/i);
    const footerRange = footerMatch && footerMatch.index !== undefined
      ? { start: tmplStart + footerMatch.index, end: tmplStart + footerMatch.index + footerMatch[0].length }
      : null;

    // Match all JSX/HTML component tags: <ComponentName ... >
    const componentTagRegex = /<([A-Z][A-Za-z0-9_.]*)\b([^>]*)(\/?>)/g;
    let match: RegExpExecArray | null;
    let clientLoadCount = 0;

    while ((match = componentTagRegex.exec(tmplText)) !== null) {
      const compName = match[1];
      const attrString = match[2];
      const startOffset = tmplStart + match.index;
      const endOffset = startOffset + match[0].length;
      const hasClientDirective = /\bclient:(load|visible|idle|media|only)\b/.test(attrString);
      const isAstroImport = importedFrameworkComponents.has(compName) &&
        importedFrameworkComponents.get(compName)!.endsWith('.astro');

      // Rule: astro/client-only-missing-framework-hint
      if (/\bclient:only\b/.test(attrString)) {
        const clientOnlyValMatch = attrString.match(/\bclient:only(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|\{([^}]*)\}|([^\s>]+)))?/);
        const val = clientOnlyValMatch ? (clientOnlyValMatch[1] ?? clientOnlyValMatch[2] ?? clientOnlyValMatch[3] ?? clientOnlyValMatch[4]) : undefined;
        if (!val || val === '' || val === 'true') {
          diagnostics.push(
            createDiagnostic({
              ruleId: 'astro/client-only-missing-framework-hint',
              framework: 'astro',
              category: 'boundary',
              severity: 'error',
              snapshot,
              content,
              startOffset,
              endOffset,
              smellTitle: `Astro Component <${compName}> Missing Framework Hint for 'client:only'`,
              smellExplanation: `Unlike 'client:load', 'client:only' bypasses server-side rendering entirely. Astro requires the framework integration name (e.g. client:only="react") to know which client renderer to load.`,
              canonSummary: `Specify the framework renderer explicitly, e.g. <${compName} client:only="react" /> or <${compName} client:only="vue" />.`,
              canonRationale: 'Astro needs to know which framework bundle to inject when SSR is bypassed.',
              canonicalCode: `<${compName} client:only="react" />`,
              referenceDoc: 'https://docs.astro.build/en/reference/directives-reference/#clientonly',
            })
          );
        }
      }

      // Rule: astro/over-hydration-client-load
      if (/\bclient:load\b/.test(attrString)) {
        clientLoadCount++;
        const isInsideFooter = footerRange && startOffset >= footerRange.start && endOffset <= footerRange.end;
        if (isInsideFooter || clientLoadCount >= 5) {
          diagnostics.push(
            createDiagnostic({
              ruleId: 'astro/over-hydration-client-load',
              framework: 'astro',
              category: 'performance',
              severity: 'warning',
              snapshot,
              content,
              startOffset,
              endOffset,
              smellTitle: isInsideFooter
                ? `Heavy 'client:load' Island <${compName}> Rendered in Footer`
                : `Excessive 'client:load' Usage (${clientLoadCount} components loaded immediately)`,
              smellExplanation: `Using 'client:load' forces immediate client bundle download and hydration on the main thread during initial page load, degrading TBT and LCP metrics.`,
              canonSummary: `Use 'client:visible' for components below the fold or 'client:idle' for non-critical widgets.`,
              canonRationale: 'Reserve client:load strictly for critical above-the-fold interactive elements.',
              canonicalCode: `<${compName} client:visible />`,
              referenceDoc: 'https://docs.astro.build/en/reference/directives-reference/#clientload',
            })
          );
        }
      }

      // Rule: astro/no-function-props-to-island
      if (hasClientDirective) {
        // Detect inline arrow function / function expression or passing frontmatter functions to island props
        const inlineFnMatch = attrString.match(/\b([a-zA-Z0-9_]+)\s*=\s*\{\s*(?:\([^)]*\)|[a-zA-Z0-9_]+)\s*=>/);
        const passedFmFnMatch = Array.from(declaredFunctionsInFm).find(fnName =>
          new RegExp(`\\b([a-zA-Z0-9_]+)\\s*=\\s*\\{\\s*${fnName}\\s*\\}`).test(attrString)
        );

        if (inlineFnMatch || passedFmFnMatch) {
          const offendingProp = inlineFnMatch ? inlineFnMatch[1] : 'handler';
          diagnostics.push(
            createDiagnostic({
              ruleId: 'astro/no-function-props-to-island',
              framework: 'astro',
              category: 'architecture',
              severity: 'error',
              snapshot,
              content,
              startOffset,
              endOffset,
              smellTitle: `Non-Serializable Function Prop '${offendingProp}' Passed to Island <${compName}>`,
              smellExplanation: `Props passed from Astro to client:* islands are serialized as HTML attribute JSON across the server-client boundary. JavaScript functions cannot be serialized.`,
              canonSummary: `Pass serializable data (JSON) and define callback handlers directly inside the framework component.`,
              canonRationale: 'Astro islands boundary requires serializable props.',
              canonicalCode: `<${compName} client:load data={serializedData} />`,
              referenceDoc: 'https://docs.astro.build/en/guides/framework-components/#passing-props-to-framework-components',
            })
          );
        }
      }

      // Rule: astro/interactive-component-missing-client-directive
      if (!hasClientDirective && !isAstroImport) {
        const hasInteractiveEventProp = /\b(on[A-Z][A-Za-z0-9_]*)=/.test(attrString);
        const isKnownFrameworkComp = importedFrameworkComponents.has(compName) &&
          /\.(vue|svelte|tsx|jsx|solid)$/i.test(importedFrameworkComponents.get(compName)!);
        const isInteractiveWidgetName = /(Modal|Dialog|Dropdown|Drawer|Menu|Select|Button|Counter|Carousel|Accordion|Tabs)$/.test(compName);

        if (hasInteractiveEventProp || (isKnownFrameworkComp && isInteractiveWidgetName)) {
          diagnostics.push(
            createDiagnostic({
              ruleId: 'astro/interactive-component-missing-client-directive',
              framework: 'astro',
              category: 'boundary',
              severity: 'warning',
              snapshot,
              content,
              startOffset,
              endOffset,
              smellTitle: `Astro Component <${compName}> Missing Hydration Directive`,
              smellExplanation: `Passing event listeners or rendering interactive framework component <${compName}> in an Astro file without a 'client:*' directive renders it as zero-JS static HTML, disabling all interactivity.`,
              canonSummary: `Add a client directive such as 'client:load', 'client:visible', or 'client:idle'.`,
              canonRationale: 'Astro Islands architecture requires explicit hydration directives for framework components that need browser interactivity.',
              canonicalCode: `<${compName} client:load />`,
              referenceDoc: 'https://docs.astro.build/en/reference/directives-reference/#client-directives',
            })
          );
        }
      }
    }
  }

  // =========================================================================
  // 3. Analyze Embedded Scripts: define:vars & is:inline
  // =========================================================================
  if (descriptor.scripts) {
    for (const scriptBlock of descriptor.scripts) {
      if (scriptBlock.attrs && scriptBlock.attrs['define:vars']) {
        // Rule: astro/define-vars-forces-inline-script
        const hasImportStatement = /\bimport\s+(?:\{[^}]*\}|\*\s+as\s+[a-zA-Z0-9_]+|[a-zA-Z0-9_]+)\s+from\s+['"][^'"]+['"]/m.test(scriptBlock.content);
        if (hasImportStatement) {
          const startOffset = scriptBlock.loc.start.offset;
          const endOffset = scriptBlock.loc.end.offset;
          diagnostics.push(
            createDiagnostic({
              ruleId: 'astro/define-vars-forces-inline-script',
              framework: 'astro',
              category: 'architecture',
              severity: 'error',
              snapshot,
              content,
              startOffset,
              endOffset,
              smellTitle: `ES Module Import Inside '<script define:vars>' Tag`,
              smellExplanation: `In Astro, 'define:vars' automatically converts the script tag into an inline script ('is:inline') that is not bundled by Vite. ES module import statements will fail in standard browser inline scripts.`,
              canonSummary: `Pass variables using HTML 'data-*' attributes (e.g. data-api-key) and query them in a standard bundled <script> tag.`,
              canonRationale: 'Scripts with define:vars are unbundled inline scripts and cannot use ES module import statements.',
              canonicalCode: `<div id="config" data-api-key={apiKey}></div>\n<script>\n  const apiKey = document.getElementById('config')?.dataset.apiKey;\n</script>`,
              referenceDoc: 'https://docs.astro.build/en/reference/directives-reference/#definevars',
            })
          );
        }
      }
    }
  }

  return diagnostics;
}


