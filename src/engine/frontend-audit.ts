import { scanRoutes, formatRoutesAsText } from './routes';
import { findUnusedComponents, formatUnusedAsText } from './audit';
import { findUnusedState, formatUnusedStateAsText } from './storage/state-storage';
import { extractWorkspaceApiContracts, formatApiContractsAsText } from './api-contract';
import { prepareIndexedAnalysis } from './prepare-index';
import type { IndexObservation } from './index-retrieval-evidence';
import type { RouteFramework, RouteManifestResult, UnusedComponentsResult, UnusedStateResult, ApiContractResult } from '../types';

interface AuditData {
  routes: RouteManifestResult;
  'dead-components': UnusedComponentsResult;
  'dead-state': UnusedStateResult;
  'api-contracts': ApiContractResult;
  all: { routes: RouteManifestResult; unusedComponents: UnusedComponentsResult; unusedState: UnusedStateResult; apiContracts: ApiContractResult };
}

export type AuditTarget = keyof AuditData;
export type AuditAnalysis = { [K in AuditTarget]: { target: K; data: AuditData[K]; before: IndexObservation | null } }[AuditTarget];
export interface FrontendAuditOptions {
  target: AuditTarget;
  targetPath: string;
  scopePath?: string;
  excludeDirs?: string[];
  ignorePatterns?: string[];
  includePages?: boolean;
  frameworkHint?: RouteFramework;
  prefix?: string;
  view?: 'summary' | 'full' | 'tree';
}

export async function analyzeFrontend(options: FrontendAuditOptions): Promise<AuditAnalysis> {
  const { target, targetPath, scopePath, excludeDirs } = options;
  const before = target === 'dead-state' || target === 'all' ? await prepareIndexedAnalysis(targetPath) : null;
  const routes = () => scanRoutes({ targetPath, scopePath, excludeDirs, frameworkHint: options.frameworkHint,
    prefix: options.prefix, view: options.view ?? (target === 'routes' ? 'summary' : undefined) });
  const components = () => findUnusedComponents({ targetPath, scopePath, excludeDirs,
    ignorePatterns: options.ignorePatterns, excludePages: !options.includePages });
  const state = () => findUnusedState(targetPath, { scopePath, excludeDirs, skipSync: true });
  const apis = () => extractWorkspaceApiContracts({ targetPath, scopePath, excludeDirs });
  switch (target) {
    case 'routes': return { target, data: await routes(), before };
    case 'dead-components': return { target, data: await components(), before };
    case 'dead-state': return { target, data: await state(), before };
    case 'api-contracts': return { target, data: await apis(), before };
    case 'all': {
      const pending = [routes(), components(), state(), apis()] as const;
      try {
        const [routes, unusedComponents, unusedState, apiContracts] = await Promise.all(pending);
        return { target, data: { routes, unusedComponents, unusedState, apiContracts }, before };
      } finally {
        // Cleanup may close shared databases only after every sibling analysis has settled.
        await Promise.allSettled(pending);
      }
    }
  }
}

export function formatFrontendAudit(analysis: AuditAnalysis, targetPath: string): string {
  switch (analysis.target) {
    case 'routes': return formatRoutesAsText(analysis.data);
    case 'dead-components': return formatUnusedAsText(analysis.data);
    case 'dead-state': return formatUnusedStateAsText(analysis.data);
    case 'api-contracts': return formatApiContractsAsText(analysis.data);
    case 'all': return [
      '## Frontend Architecture & Health Audit', `Target: \`${targetPath}\`\n`,
      formatRoutesAsText(analysis.data.routes), '\n---\n', formatUnusedAsText(analysis.data.unusedComponents),
      '\n---\n', formatUnusedStateAsText(analysis.data.unusedState), '\n---\n', formatApiContractsAsText(analysis.data.apiContracts),
    ].join('\n');
  }
}
