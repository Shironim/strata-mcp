import { parseTypeScript } from './source-parser';
import { readSourceFile } from './source-file';
import { createDocumentAdapter } from '../adapters/factory';
import { extractNuxtPageMeta, extractNextSegmentConfig } from './routes';
import { existsSync } from 'node:fs';
import { basename, extname, resolve, dirname } from 'node:path';
import { createHash } from 'node:crypto';
import { findProjectRoot, canonicalizePath } from './path-resolver';
import { resolveModuleFilePath, extractImportedSymbols } from './symbol-resolver';
import ts from 'typescript';
import type { ComponentContract } from '../types';
import { extractVueContract, extractVueComposableContract } from './parsers/contract-vue';
import { extractReactContract } from './parsers/contract-react';
import { extractAstroContract } from './parsers/contract-astro';
import { extractSvelteContract } from './parsers/contract-svelte';
import { extractStateDependencies, extractDataDependencies } from './parsers/state-dependency';
import { getProjectEcosystem, detectFramework, detectFrameworkWithEvidence, componentFramework, type ProjectEcosystem, type ProjectFrameworkInfo, type FrameworkDetectionResult } from './framework-detector';
import { extractLayoutStructure } from './layout-extractor';
import { extractRenderBoundary } from './contracts/render-boundary';
import { extractComponentVariants } from './contracts/variants';
import { extractBoundaryContracts, extractFormContracts } from './contracts/boundaries';

export { extractRenderBoundary } from './contracts/render-boundary';
export { extractComponentVariants } from './contracts/variants';
export { extractBoundaryContracts } from './contracts/boundaries';
export { extractFormContracts } from './contracts/boundaries';

// Re-export submodules for 100% backward compatibility
export * from './parsers/contract-vue';
export * from './parsers/contract-react';
export * from './parsers/contract-astro';
export * from './parsers/contract-svelte';
export * from './parsers/state-dependency';

export {
  getProjectEcosystem,
  detectFramework,
  detectFrameworkWithEvidence,
};
export type {
  ProjectEcosystem,
  ProjectFrameworkInfo,
  FrameworkDetectionResult,
};

export { COMMON_HOOKS_IGNORE } from './parsers/hook-names';

export interface ExtractContractOptions {
  path?: string;
  workspaceRoot?: string;
}

/**
 * Public facade: extracts the public contract of a component (.vue, .tsx, .jsx, .astro).
 */
export async function extractComponentContract(
  filePath: string,
  explicitContentOrOptions?: string | ExtractContractOptions,
  maybeOptions?: ExtractContractOptions
): Promise<ComponentContract> {
  const resolvedPath = resolve(filePath);
  const explicitContent =
    typeof explicitContentOrOptions === 'string' ? explicitContentOrOptions : undefined;
  const options: ExtractContractOptions =
    typeof explicitContentOrOptions === 'object'
      ? explicitContentOrOptions
      : maybeOptions || {};

  const content =
    explicitContent !== undefined
      ? explicitContent
      : await readSourceFile(resolvedPath);
  const detection = detectFrameworkWithEvidence(resolvedPath, content, options.workspaceRoot);
  const framework = componentFramework(resolvedPath, detection.framework);

  let baseContract: ComponentContract;
  switch (framework) {
    case 'vue':
    case 'nuxt':
      baseContract = await extractVueContract(resolvedPath, content, options);
      break;
    case 'react':
    case 'next':
      baseContract = await extractReactContract(resolvedPath, content, options?.workspaceRoot);
      break;
    case 'astro':
      baseContract = await extractAstroContract(resolvedPath, content);
      break;
    case 'svelte':
      baseContract = await extractSvelteContract(resolvedPath, content);
      break;
    case 'vue-composable':
      baseContract = await extractVueComposableContract(resolvedPath, content);
      break;
    default: {
      const component = basename(resolvedPath, extname(resolvedPath));
      baseContract = {
        component,
        framework: framework || 'unknown',
        filePath: resolvedPath,
        props: [],
        emits: [],
        slots: [],
      };
      break;
    }
  }

  const renderBoundary = framework === 'vue-composable'
    ? undefined
    : extractRenderBoundary(resolvedPath, content, framework, detection.projectContext);
  const stateDependencies = extractStateDependencies(content, framework, baseContract.component);
  const dataDependencies = extractDataDependencies(content, framework);
  const variants = extractComponentVariants(content, baseContract.props);

  const boundaryContracts = extractBoundaryContracts(content, framework);
  for (const b of boundaryContracts) {
    if (!b.source) b.source = 'inline';
  }

  const dependencies = new Map((baseContract.dependencies ?? []).map(input => [input.path, input]));

  // 1-Hop outbound API resolution from local composables / hooks
  const workspaceRoot = options?.workspaceRoot || findProjectRoot(resolvedPath) || dirname(resolvedPath);
  try {
    const importedSymbols = extractImportedSymbols(resolvedPath, content);
    const scriptBlocks = createDocumentAdapter(resolvedPath, content).getScriptBlocks();
    for (const [localName, importInfo] of importedSymbols.entries()) {
      if (!localName.startsWith('use') && !importInfo.importedName.startsWith('use')) continue;
      let called = false;
      let shadowed = false;
      for (const block of scriptBlocks) {
        const ast = parseTypeScript(resolvedPath, block.content, ts.ScriptKind.TSX);
        const visit = (node: ts.Node): void => {
          if (ts.isCallExpression(node) && ts.isIdentifier(node.expression) && node.expression.text === localName) called = true;
          if ((ts.isParameter(node) || ts.isVariableDeclaration(node) || ts.isFunctionDeclaration(node))
            && node.name && ts.isIdentifier(node.name) && node.name.text === localName) shadowed = true;
          ts.forEachChild(node, visit);
        };
        visit(ast);
      }
      if (!called || shadowed) continue;
      const composablePath = resolveModuleFilePath(resolvedPath, importInfo.sourceModule, workspaceRoot);
      if (!composablePath || composablePath === resolvedPath || !existsSync(composablePath)) continue;
      const compContent = await readSourceFile(composablePath);
      const canonCompPath = canonicalizePath(composablePath);
      // Track inspected modules even when no endpoint is found, so later edits invalidate the contract.
      dependencies.set(canonCompPath, { path: canonCompPath, hash: createHash('sha256').update(compContent).digest('hex'), isExternal: false });
      const ast = parseTypeScript(composablePath, compContent, ts.ScriptKind.TSX);
      for (const statement of ast.statements) {
        let hook: ts.FunctionDeclaration | ts.ArrowFunction | ts.FunctionExpression | undefined;
        if (ts.isFunctionDeclaration(statement) && statement.body
          && (statement.name?.text === importInfo.importedName
            || (importInfo.importedName === 'default' && statement.modifiers?.some(m => m.kind === ts.SyntaxKind.DefaultKeyword)))) hook = statement;
        if (ts.isVariableStatement(statement)) {
          for (const declaration of statement.declarationList.declarations) {
            if (ts.isIdentifier(declaration.name) && declaration.name.text === importInfo.importedName
              && declaration.initializer && (ts.isArrowFunction(declaration.initializer) || ts.isFunctionExpression(declaration.initializer))) hook = declaration.initializer;
          }
        }
        if (!hook) continue;
        const lineOffset = ast.getLineAndCharacterOfPosition(hook.getStart(ast)).line;
        for (const cb of extractBoundaryContracts(hook.getText(ast), 'ts')) {
          boundaryContracts.push({ ...cb, ...(cb.loc ? { loc: { ...cb.loc, line: cb.loc.line + lineOffset } } : {}), source: 'imported-composable', viaComposable: localName });
        }
      }
    }
  } catch {
    // Graceful fallback
  }

  const formContracts = extractFormContracts(content);
  const layoutStructure = extractLayoutStructure(resolvedPath, content, framework);

  const nuxtPageMeta = (framework === 'nuxt' || content.includes('definePageMeta'))
    ? extractNuxtPageMeta(content)
    : undefined;

  const nextSegmentConfig = (framework === 'react' || framework === 'next')
    ? extractNextSegmentConfig(content)
    : undefined;
  for (const input of detection.projectContext?.dependencies ?? []) {
    if (dependencies.has(input.path) && dependencies.get(input.path)!.hash !== input.hash) {
      detection.projectContext!.diagnostics.push({ code: 'DEPENDENCY_CHANGED', reason: `${input.path}: ownership and contract reads observed different input hashes.` });
    }
    dependencies.set(input.path, input);
  }

  return {
    ...baseContract,
    framework,
    projectContext: detection.projectContext,
    dependencies: [...dependencies.values()],
    variants,
    renderBoundary,
    stateDependencies,
    dataDependencies,
    layoutStructure:
      layoutStructure && ((layoutStructure.rootWrapper && layoutStructure.rootWrapper.layoutTokens && layoutStructure.rootWrapper.layoutTokens.length > 0) || (layoutStructure.dynamicBindings && layoutStructure.dynamicBindings.length > 0) || (layoutStructure.visibilityDirectives && layoutStructure.visibilityDirectives.length > 0))
        ? layoutStructure
        : undefined,
    boundaryContracts: boundaryContracts.length > 0 ? boundaryContracts : undefined,
    formContracts: formContracts.length > 0 ? formContracts : undefined,
    nuxtPageMeta,
    ...(nextSegmentConfig ? { nextSegmentConfig } : {}),
  };
}

export { formatContractAsText } from './formatter';
