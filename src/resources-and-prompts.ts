import { resolve } from 'node:path';
import { getLastKnownProjectRoot } from './engine/path-resolver';
import {
  inspectFile,
  mapWorkspace,
  searchCode,
} from './engine/v2';
import { findWorkflowPlaybook, WORKFLOW_PLAYBOOKS } from './workflow-playbooks';

export const STRATA_RESOURCES = [
  {
    uri: 'strata://project/overview',
    name: 'Strata Project Overview',
    description:
      'Detected monorepo packages, frameworks, routers, and file/symbol/route totals for the active workspace.',
    mimeType: 'application/json',
  },
  {
    uri: 'strata://components/index',
    name: 'Strata Components Index',
    description:
      'Bounded list of discovered frontend components and their package-relative paths without source bodies.',
    mimeType: 'application/json',
  },
] as const;

export const STRATA_RESOURCE_TEMPLATES = [
  {
    uriTemplate: 'strata://component/{name}',
    name: 'Strata Component Contract',
    description:
      'Read-only component outline, TypeChecker-resolved props/slots contract, and outbound HTTP boundaries.',
    mimeType: 'application/json',
  },
] as const;

export const STRATA_PROMPTS = WORKFLOW_PLAYBOOKS.map(({ name, title, description, arguments: args }) => ({
  name,
  title,
  description,
  arguments: args,
}));

export function listStrataResources() {
  return { resources: [...STRATA_RESOURCES] };
}

export function listStrataResourceTemplates() {
  return { resourceTemplates: [...STRATA_RESOURCE_TEMPLATES] };
}

export function listStrataPrompts() {
  return { prompts: [...STRATA_PROMPTS] };
}

function resolveWorkspaceRoot(explicitRoot?: string): string {
  const candidate = explicitRoot?.trim() || getLastKnownProjectRoot() || process.cwd();
  return resolve(candidate);
}

export async function readStrataResource(uri: string, explicitRoot?: string) {
  const workspaceRoot = resolveWorkspaceRoot(explicitRoot);

  if (uri === 'strata://project/overview') {
    const overview = await mapWorkspace({ workspaceRoot, view: 'overview' });
    return {
      contents: [
        {
          uri,
          mimeType: 'application/json',
          text: JSON.stringify(overview, null, 2),
        },
      ],
    };
  }

  if (uri === 'strata://components/index') {
    const files = await mapWorkspace({ workspaceRoot, view: 'files', limit: 150 });
    return {
      contents: [
        {
          uri,
          mimeType: 'application/json',
          text: JSON.stringify(files, null, 2),
        },
      ],
    };
  }

  const compMatch = /^strata:\/\/component\/(.+)$/.exec(uri);
  if (compMatch) {
    const compName = decodeURIComponent(compMatch[1]);
    const hits = await searchCode({
      workspaceRoot,
      query: compName,
      kind: 'symbol',
      symbolKinds: ['component'],
      limit: 5,
    });
    const inspections = [];
    for (const hit of hits.data.matches) {
      try {
        inspections.push(
          await inspectFile({ workspaceRoot, path: hit.filePath, skipSync: true })
        );
      } catch {
        // skip unreadable candidate
      }
    }
    return {
      contents: [
        {
          uri,
          mimeType: 'application/json',
          text: JSON.stringify({ component: compName, matches: inspections }, null, 2),
        },
      ],
    };
  }

  throw new Error(`Unknown Strata resource URI: "${uri}"`);
}

export async function getStrataPrompt(
  name: string,
  rawArgs?: Record<string, string>,
  explicitRoot?: string
) {
  const args = rawArgs ?? {};
  const workspaceRoot = resolveWorkspaceRoot(explicitRoot ?? args.root);
  const playbook = findWorkflowPlaybook(name);
  if (!playbook) {
    throw new Error(`Unknown prompt: '${name}'`);
  }

  const overview = await mapWorkspace({ workspaceRoot, view: 'overview' });
  const targetArg =
    playbook.name === 'trace-bug'
      ? (args.target ?? '').trim() || '<target>'
      : playbook.name === 'safe-refactor'
        ? (args.component ?? '').trim() || '<component>'
        : (args.package ?? '').trim();

  const ctx = {
    target: targetArg,
    workspaceRoot,
    refactorType: args.member ?? args.refactor_type,
  };

  return {
    description: playbook.promptDescription,
    messages: [
      {
        role: 'user' as const,
        content: {
          type: 'resource' as const,
          resource: {
            uri: 'strata://project/overview',
            mimeType: 'application/json',
            text: JSON.stringify(overview, null, 2),
          },
        },
      },
      {
        role: 'user' as const,
        content: {
          type: 'text' as const,
          text: [playbook.intro(ctx), ...playbook.steps(ctx)].join('\n'),
        },
      },
    ],
  };
}
