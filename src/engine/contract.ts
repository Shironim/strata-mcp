import { readSourceFile } from './source-file';
import { extractNuxtPageMeta, extractNextSegmentConfig } from './routes';
import { basename, extname, resolve, dirname } from 'node:path';
import { findProjectRoot } from './path-resolver';
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
import { extractImportedComposableBoundaries } from './contracts/imported-composable-boundaries';

export { extractRenderBoundary } from './contracts/render-boundary';
export { extractComponentVariants } from './contracts/variants';
export { extractBoundaryContracts } from './contracts/boundaries';
export { extractFormContracts } from './contracts/boundaries';

// Re-export submodules through the existing public facade
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

  const boundaryContracts = extractBoundaryContracts(content, framework, resolvedPath);
  for (const b of boundaryContracts) {
    if (!b.source) b.source = 'inline';
  }

  const dependencies = new Map((baseContract.dependencies ?? []).map(input => [input.path, input]));

  const workspaceRoot = options?.workspaceRoot || findProjectRoot(resolvedPath) || dirname(resolvedPath);
  const imported = await extractImportedComposableBoundaries(resolvedPath, content, workspaceRoot);
  boundaryContracts.push(...imported.boundaries);
  for (const input of imported.dependencies) dependencies.set(input.path, input);

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
    ...(imported.diagnostics.length ? { boundaryDiagnostics: imported.diagnostics } : {}),
    formContracts: formContracts.length > 0 ? formContracts : undefined,
    nuxtPageMeta,
    ...(nextSegmentConfig ? { nextSegmentConfig } : {}),
  };
}

export { formatContractAsText } from './formatter';
