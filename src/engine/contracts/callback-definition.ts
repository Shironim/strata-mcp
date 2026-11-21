import { createHash } from 'node:crypto';
import { realpath } from 'node:fs/promises';
import { isAbsolute, relative, sep } from 'node:path';
import ts from 'typescript';
import type { BoundaryContract, CallbackDefinition, InputDependency } from '../../types';
import { checkAnalysisCancelled } from '../analysis-context';
import { callableName } from '../parsers/ts-syntax';
import { parseTypeScript } from '../source-parser';
import { readSourceFile } from '../source-file';
import { resolveModuleFilePath } from '../symbol-resolver';
import type { observeHttpDocument } from './outbound-http';

export type CallbackTarget = { definition: CallbackDefinition } | { module: string; symbol: string };

async function readDefinitions(path: string, root: string) {
  const rel = relative(await realpath(root), await realpath(path));
  if (isAbsolute(rel) || rel === '..' || rel.startsWith('..' + sep)) return;
  const source = await readSourceFile(path);
  const sf = parseTypeScript(path, source, /\.[jt]sx$/.test(path) ? ts.ScriptKind.TSX : ts.ScriptKind.TS);
  const definitions = new Map<string, CallbackDefinition | undefined>();
  for (const statement of sf.statements) {
    const modifiers = ts.canHaveModifiers(statement) ? ts.getModifiers(statement) : undefined;
    if (!modifiers?.some(m => m.kind === ts.SyntaxKind.ExportKeyword) ||
      modifiers.some(m => m.kind === ts.SyntaxKind.DefaultKeyword)) continue;
    const declarations = ts.isVariableStatement(statement) ? statement.declarationList.declarations : [statement];
    for (const declaration of declarations) {
      const name = callableName(declaration);
      if (!name) continue;
      const pos = sf.getLineAndCharacterOfPosition(name.getStart(sf));
      definitions.set(name.text, definitions.has(name.text) ? undefined :
        { symbol: name.text, file: path, line: pos.line + 1, column: pos.character + 1 });
    }
  }
  return { definitions, dependency: { path, hash: createHash('sha256').update(source).digest('hex'), isExternal: false } };
}

export async function attachCallbackDefinitions(file: string, root: string, boundaries: BoundaryContract[],
  observations: ReturnType<typeof observeHttpDocument>, dependencies: Map<string, InputDependency>) {
  const unresolved = new Map(boundaries.filter(b => b.endpointSource === 'action-symbol' && b.boundaryType === 'tanstack-query')
    .map(b => [`${b.loc?.line}:${b.loc?.column}`, b]));
  const modules = new Map<string, Awaited<ReturnType<typeof readDefinitions>>>();
  for (const mutation of observations.mutations) {
    const boundary = unresolved.get(`${mutation.line}:${mutation.column}`);
    if (!boundary) continue;
    const target = mutation.callbackTarget?.();
    if (!target) continue;
    if ('definition' in target) {
      boundary.callbackDefinition = target.definition;
      continue;
    }
    const path = resolveModuleFilePath(file, target.module, root);
    if (!path || !/\.[cm]?[jt]sx?$/.test(path) || /\.d\.[cm]?ts$/.test(path)) continue;
    if (!modules.has(path)) {
      try {
        modules.set(path, await readDefinitions(path, root));
      } catch (error) {
        checkAnalysisCancelled();
        if (error instanceof Error && error.message.startsWith('WORKSPACE_CHANGED')) throw error;
        modules.set(path, undefined);
      }
    }
    const result = modules.get(path);
    if (!result) continue;
    const previous = dependencies.get(path);
    if (previous && previous.hash !== result.dependency.hash) throw new Error('WORKSPACE_CHANGED: callback module changed during inspection');
    dependencies.set(path, result.dependency);
    const definition = result.definitions.get(target.symbol);
    if (definition) boundary.callbackDefinition = definition;
  }
}
