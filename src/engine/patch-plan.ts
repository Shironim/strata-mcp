import { readSourceFile } from './source-file';
import { promises as fs, existsSync } from 'node:fs';
import { basename, extname, resolve } from 'node:path';
import { parse as parseDom, NodeTypes, type ElementNode, type RootNode, type TemplateChildNode } from '@vue/compiler-dom';
import { parseSfc } from './splitter';
import { getComponentTree, extractLocalImports, resolveImportPath, resolveBarrelExport } from './tree';
import ts from 'typescript';
import { loadAliasConfig } from './resolver';
import { findProjectRoot } from './path-resolver';
import { STRATA_VERSION } from '../version';
import { escapeRegExp } from './patterns';
import type {
  ComponentPatchItem,
  PatchPlanOptions,
  PatchPlanResult,
  PatchRefactorType,
} from '../types';

/**
 * Converts a PascalCase or camelCase string to kebab-case.
 */
function toKebabCase(str: string): string {
  return str
    .replace(/([a-z0-9])([A-Z])/g, '$1-$2')
    .replace(/[\s_]+/g, '-')
    .toLowerCase();
}

/**
 * Converts a kebab-case string to camelCase.
 */
function toCamelCase(str: string): string {
  return str.replace(/-([a-z0-9])/g, (_, g) => g.toUpperCase());
}

/**
 * Strips Vue directive prefixes (: / v-bind: / @ / v-on: / # / v-slot:) from a prop, event, or slot name.
 */
export function cleanIdentifier(name: string): string {
  return name
    .replace(/^v-bind:/, '')
    .replace(/^:/, '')
    .replace(/^v-on:/, '')
    .replace(/^@/, '')
    .replace(/^v-slot:/, '')
    .replace(/^#/, '')
    .trim();
}

/**
 * Checks whether an attribute name matches target prop across camelCase and kebab-case conventions.
 */
export function matchVueProp(attributeName: string, targetProp: string): boolean {
  const cleanAttr = cleanIdentifier(attributeName);
  const cleanTarget = cleanIdentifier(targetProp);
  return (
    cleanAttr === cleanTarget ||
    toCamelCase(cleanAttr) === toCamelCase(cleanTarget) ||
    toKebabCase(cleanAttr) === toKebabCase(cleanTarget)
  );
}

/**
 * Checks whether an event listener attribute matches target event across conventions.
 */
export function matchVueEvent(attributeName: string, targetEvent: string): boolean {
  const cleanAttr = cleanIdentifier(attributeName);
  const cleanTarget = cleanIdentifier(targetEvent);
  return (
    cleanAttr === cleanTarget ||
    toCamelCase(cleanAttr) === toCamelCase(cleanTarget) ||
    toKebabCase(cleanAttr) === toKebabCase(cleanTarget)
  );
}

/**
 * Generates all candidate tag names for a given component basename (e.g. "UserCard" -> ["UserCard", "user-card"]).
 */
function getCandidateTagNames(compName: string): Set<string> {
  const set = new Set<string>();
  set.add(compName);
  set.add(toKebabCase(compName));
  set.add(toCamelCase(compName));
  return set;
}

/**
 * Traverses Vue AST and locates exact attribute locations for patching.
 */
function scanVueTemplateProps(
  templateContent: string,
  templateStartLine: number,
  templateStartCol: number,
  targetTags: Set<string>,
  refactorType: PatchRefactorType,
  oldName: string,
  newName: string | undefined,
  filePath: string
): ComponentPatchItem[] {
  const patches: ComponentPatchItem[] = [];
  const cleanOld = cleanIdentifier(oldName);
  const cleanNew = newName ? cleanIdentifier(newName) : undefined;
  const oldKebab = toKebabCase(cleanOld);
  const oldCamel = toCamelCase(cleanOld);
  const newKebab = cleanNew ? toKebabCase(cleanNew) : '';
  const newCamel = cleanNew ? toCamelCase(cleanNew) : '';

  let ast: RootNode;
  try {
    ast = parseDom(templateContent);
  } catch {
    return patches;
  }

  function handleAttributeProp(
    prop: any,
    el: ElementNode,
    absLine: number,
    absCol: number,
    rawPropText: string
  ): void {
    if (!matchVueProp(prop.name, cleanOld)) return;

    if (refactorType === 'rename_prop' && newName) {
      const targetReplacementAttr = prop.name.includes('-') ? newKebab : newCamel;
      const newSnippet = rawPropText.replace(new RegExp(`^${escapeRegExp(prop.name)}`), targetReplacementAttr);
      patches.push({
        file: filePath,
        line: absLine,
        column: absCol,
        targetTag: el.tag,
        oldSnippet: rawPropText,
        newSnippet,
        description: `Rename static prop attribute "${prop.name}" to "${targetReplacementAttr}" on <${el.tag}>`,
      });
    } else if (refactorType === 'remove_prop') {
      patches.push({
        file: filePath,
        line: absLine,
        column: absCol,
        targetTag: el.tag,
        oldSnippet: rawPropText,
        newSnippet: '',
        description: `Remove obsolete static prop "${prop.name}" on <${el.tag}>`,
      });
    }
  }

  function handleDirectiveProp(
    prop: any,
    el: ElementNode,
    absLine: number,
    absCol: number,
    rawPropText: string
  ): void {
    if (prop.name !== 'bind' && prop.name) return;
    const argContent = prop.arg && 'content' in prop.arg ? prop.arg.content : '';
    if (!matchVueProp(argContent, cleanOld)) return;

    if (refactorType === 'rename_prop' && newName) {
      const targetReplacementAttr = argContent.includes('-') ? newKebab : newCamel;
      const isShorthand = rawPropText.startsWith(':');
      const prefix = isShorthand ? ':' : 'v-bind:';
      const expPart = prop.exp && 'content' in prop.exp ? `="${prop.exp.content}"` : '';
      const newSnippet = `${prefix}${targetReplacementAttr}${expPart}`;

      patches.push({
        file: filePath,
        line: absLine,
        column: absCol,
        targetTag: el.tag,
        oldSnippet: rawPropText,
        newSnippet,
        description: `Rename bound prop "${argContent}" to "${targetReplacementAttr}" on <${el.tag}>`,
      });
    } else if (refactorType === 'remove_prop') {
      patches.push({
        file: filePath,
        line: absLine,
        column: absCol,
        targetTag: el.tag,
        oldSnippet: rawPropText,
        newSnippet: '',
        description: `Remove bound prop "${argContent}" on <${el.tag}>`,
      });
    }
  }

  function handleEventDirective(
    prop: any,
    el: ElementNode,
    absLine: number,
    absCol: number,
    rawPropText: string
  ): void {
    if (prop.name !== 'on') return;
    const eventName = prop.arg && 'content' in prop.arg ? prop.arg.content : '';
    if (!matchVueEvent(eventName, cleanOld)) return;

    if (refactorType === 'rename_event' && newName) {
      const targetReplacementEvent = eventName.includes('-') ? newKebab : newCamel;
      const isShorthand = rawPropText.startsWith('@');
      const prefix = isShorthand ? '@' : 'v-on:';
      const expPart = prop.exp && 'content' in prop.exp ? `="${prop.exp.content}"` : '';
      const newSnippet = `${prefix}${targetReplacementEvent}${expPart}`;

      patches.push({
        file: filePath,
        line: absLine,
        column: absCol,
        targetTag: el.tag,
        oldSnippet: rawPropText,
        newSnippet,
        description: `Rename event listener "${eventName}" to "${targetReplacementEvent}" on <${el.tag}>`,
      });
    } else if (refactorType === 'remove_event') {
      patches.push({
        file: filePath,
        line: absLine,
        column: absCol,
        targetTag: el.tag,
        oldSnippet: rawPropText,
        newSnippet: '',
        description: `Remove event listener "${eventName}" on <${el.tag}>`,
      });
    }
  }

  function handleModelDirective(
    prop: any,
    el: ElementNode,
    absLine: number,
    absCol: number,
    rawPropText: string
  ): void {
    if (prop.name !== 'model') return;
    const modelArg = prop.arg && 'content' in prop.arg ? prop.arg.content : 'modelValue';
    const isDefaultModel = !prop.arg || modelArg === 'modelValue';
    const matches =
      matchVueProp(modelArg, cleanOld) ||
      (isDefaultModel && (cleanOld === 'modelValue' || cleanOld === 'model'));

    if (!matches) return;

    if (refactorType === 'rename_model' && newName) {
      const targetReplacementModel = modelArg.includes('-') ? newKebab : newCamel;
      let newSnippet: string;
      if (!prop.arg) {
        newSnippet = rawPropText.replace(/^v-model\b/, `v-model:${targetReplacementModel}`);
      } else {
        newSnippet = rawPropText.replace(
          new RegExp(`(:)${escapeRegExp(modelArg)}\\b`),
          `$1${targetReplacementModel}`
        );
      }

      patches.push({
        file: filePath,
        line: absLine,
        column: absCol,
        targetTag: el.tag,
        oldSnippet: rawPropText,
        newSnippet,
        description: `Rename v-model binding "${modelArg}" to "${targetReplacementModel}" on <${el.tag}>`,
      });
    } else if (refactorType === 'remove_model') {
      patches.push({
        file: filePath,
        line: absLine,
        column: absCol,
        targetTag: el.tag,
        oldSnippet: rawPropText,
        newSnippet: '',
        description: `Remove v-model binding "${modelArg}" on <${el.tag}>`,
      });
    }
  }

  function handleSlotDirective(
    prop: any,
    targetTag: string,
    absLine: number,
    absCol: number,
    rawPropText: string
  ): void {
    if (prop.name !== 'slot') return;
    const slotName = prop.arg && 'content' in prop.arg ? prop.arg.content : 'default';
    const matches =
      matchVueProp(slotName, cleanOld) ||
      (slotName === 'default' && (cleanOld === 'default' || cleanOld === 'slot'));

    if (!matches) return;

    if (refactorType === 'rename_slot' && newName) {
      const targetReplacementSlot = slotName.includes('-') ? newKebab : newCamel;
      let newSnippet = rawPropText;
      if (rawPropText.startsWith('#')) {
        newSnippet = rawPropText.replace(
          new RegExp(`^#${escapeRegExp(slotName)}\\b`),
          `#${targetReplacementSlot}`
        );
      } else if (rawPropText.startsWith('v-slot:')) {
        newSnippet = rawPropText.replace(
          new RegExp(`^v-slot:${escapeRegExp(slotName)}\\b`),
          `v-slot:${targetReplacementSlot}`
        );
      } else if (rawPropText.startsWith('v-slot')) {
        newSnippet = rawPropText.replace(/^v-slot\b/, `v-slot:${targetReplacementSlot}`);
      }

      patches.push({
        file: filePath,
        line: absLine,
        column: absCol,
        targetTag,
        oldSnippet: rawPropText,
        newSnippet,
        description: `Rename slot "${slotName}" to "${targetReplacementSlot}" on <${targetTag}>`,
      });
    } else if (refactorType === 'remove_slot') {
      patches.push({
        file: filePath,
        line: absLine,
        column: absCol,
        targetTag,
        oldSnippet: rawPropText,
        newSnippet: '',
        description: `Remove slot "${slotName}" on <${targetTag}>`,
      });
    }
  }

  function walk(node: RootNode | TemplateChildNode): void {
    if (node.type === NodeTypes.ELEMENT) {
      const el = node as ElementNode;
      const tagMatches = targetTags.has(el.tag) || targetTags.has(toKebabCase(el.tag));

      if (tagMatches) {
        for (const prop of el.props) {
          const absLine = templateStartLine + prop.loc.start.line - 1;
          const absCol =
            prop.loc.start.line === 1
              ? templateStartCol + prop.loc.start.column - 1
              : prop.loc.start.column;
          const rawPropText = prop.loc.source;

          if (refactorType === 'rename_prop' || refactorType === 'remove_prop') {
            if (prop.type === NodeTypes.ATTRIBUTE) {
              handleAttributeProp(prop, el, absLine, absCol, rawPropText);
            } else if (prop.type === NodeTypes.DIRECTIVE) {
              handleDirectiveProp(prop, el, absLine, absCol, rawPropText);
            }
          } else if (refactorType === 'rename_event' || refactorType === 'remove_event') {
            if (prop.type === NodeTypes.DIRECTIVE) {
              handleEventDirective(prop, el, absLine, absCol, rawPropText);
            }
          } else if (refactorType === 'rename_model' || refactorType === 'remove_model') {
            if (prop.type === NodeTypes.DIRECTIVE) {
              handleModelDirective(prop, el, absLine, absCol, rawPropText);
            }
          } else if (refactorType === 'rename_slot' || refactorType === 'remove_slot') {
            if (prop.type === NodeTypes.DIRECTIVE) {
              handleSlotDirective(prop, el.tag, absLine, absCol, rawPropText);
            }
          }
        }

        // Check slot directives on child <template> elements
        if (refactorType === 'rename_slot' || refactorType === 'remove_slot') {
          for (const child of el.children || []) {
            if (child.type === NodeTypes.ELEMENT && (child as ElementNode).tag === 'template') {
              const templateChild = child as ElementNode;
              for (const tProp of templateChild.props) {
                if (tProp.type === NodeTypes.DIRECTIVE && tProp.name === 'slot') {
                  const tLine = templateStartLine + tProp.loc.start.line - 1;
                  const tCol =
                    tProp.loc.start.line === 1
                      ? templateStartCol + tProp.loc.start.column - 1
                      : tProp.loc.start.column;
                  handleSlotDirective(tProp, el.tag, tLine, tCol, tProp.loc.source);
                }
              }
            }
          }
        }
      }
    }

    if ('children' in node && Array.isArray((node as any).children)) {
      (node as any).children.forEach(walk);
    }
  }

  walk(ast);
  return patches;
}

/**
 * Scans JSX/TSX files with precision regex matching for component usage and prop attributes.
 */
function scanJsxProps(
  code: string,
  targetTags: Set<string>,
  refactorType: PatchRefactorType,
  oldName: string,
  newName: string | undefined,
  filePath: string
): ComponentPatchItem[] {
  const patches: ComponentPatchItem[] = [];
  const cleanOld = cleanIdentifier(oldName);
  const cleanNew = newName ? cleanIdentifier(newName) : undefined;
  const sf = ts.createSourceFile(filePath, code, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  const renames = refactorType.startsWith('rename_');
  function visit(node: ts.Node): void {
    if (ts.isJsxOpeningElement(node) || ts.isJsxSelfClosingElement(node)) {
      const tag = node.tagName.getText(sf);
      if (targetTags.has(tag)) {
        for (const attr of node.attributes.properties) {
          if (!ts.isJsxAttribute(attr) || !matchVueProp(attr.name.getText(sf), cleanOld)) continue;
          if (renames && !cleanNew) continue;
          const target = renames ? attr.name : attr;
          const position = sf.getLineAndCharacterOfPosition(target.getStart(sf));
          patches.push({
            file: filePath,
            line: position.line + 1,
            column: position.character + 1,
            targetTag: tag,
            oldSnippet: target.getText(sf),
            newSnippet: renames ? toCamelCase(cleanNew!) : '',
            description: `${renames ? 'Rename' : 'Remove'} JSX attribute "${attr.name.getText(sf)}" on <${tag}>`,
          });
        }
      }
    }
    ts.forEachChild(node, visit);
  }
  visit(sf);

  return patches;
}

/**
 * Generates an automated, prescriptive AST patch plan across all upward consumers of a component.
 */
export async function generatePatchPlan(options: PatchPlanOptions): Promise<PatchPlanResult> {
  const { componentPath, refactorType, oldName, newName, targetPath } = options;
  const validRefactorTypes: PatchRefactorType[] = [
    'rename_prop', 'remove_prop', 'rename_event', 'remove_event',
    'rename_model', 'remove_model', 'rename_slot', 'remove_slot',
  ];
  if (!validRefactorTypes.includes(refactorType)) {
    throw new Error(`Invalid refactor_type. Supported operations: ${validRefactorTypes.join(', ')}.`);
  }
  const cleanOld = typeof oldName === 'string' ? cleanIdentifier(oldName.trim()) : '';
  const cleanNew = typeof newName === 'string' ? cleanIdentifier(newName.trim()) : undefined;
  if (!cleanOld) {
    throw new Error('"old_name" is required and must not be empty.');
  }
  if (refactorType.startsWith('rename_') && !cleanNew) {
    throw new Error(`"new_name" is required when refactor_type is "${refactorType}".`);
  }
  const projectRoot = targetPath ? resolve(targetPath) : findProjectRoot(componentPath);
  const absComponentPath = resolve(componentPath);

  const compName = basename(absComponentPath, extname(absComponentPath));
  const targetTags = getCandidateTagNames(compName);

  // 1. Resolve upward tree to get all consumer components (blast radius)
  const treeResult = await getComponentTree({
    entryPath: absComponentPath,
    direction: 'upward',
    targetPath: projectRoot,
  });

  const consumerFiles = new Set<string>();

  function collectConsumerPaths(node: typeof treeResult.root): void {
    const candidatePath = node.filePath || (node as any).path;
    if (candidatePath && resolve(candidatePath) !== absComponentPath) {
      consumerFiles.add(candidatePath);
    }
    node.children?.forEach(collectConsumerPaths);
  }

  collectConsumerPaths(treeResult.root);

  const allPatches: ComponentPatchItem[] = [];

  // 2. For each consumer file, parse template / JSX and locate exact code replacements
  for (const consumerPath of consumerFiles) {
    if (!existsSync(consumerPath)) {
      continue;
    }

    try {
      const content = await readSourceFile(consumerPath);
      const ext = extname(consumerPath).toLowerCase();
      const aliasConfig = await loadAliasConfig(consumerPath);
      const consumerTags = new Set(ext === '.tsx' || ext === '.jsx' ? [] : targetTags);
      for (const imp of extractLocalImports(content, aliasConfig)) {
        let importedPath = resolveImportPath(consumerPath, imp.source, aliasConfig);
        if (importedPath && /[/\\]index\.[tj]sx?$/.test(importedPath)) {
          importedPath = resolveBarrelExport(importedPath, imp.name, aliasConfig) ?? importedPath;
        }
        if (importedPath && resolve(importedPath) === absComponentPath) {
          consumerTags.add(imp.alias || imp.name);
        }
      }


      if (ext === '.vue') {
        const sfc = parseSfc(content, consumerPath);
        if (sfc.template) {
          const templatePatches = scanVueTemplateProps(
            sfc.template.content,
            sfc.template.loc.start.line,
            sfc.template.loc.start.column,
            consumerTags,
            refactorType,
            cleanOld,
            cleanNew,
            consumerPath
          );
          allPatches.push(...templatePatches);
        }
      } else if (ext === '.astro') {
        // Astro templates can be parsed via DOM parser
        const astroTemplatePatches = scanVueTemplateProps(
          content,
          1,
          1,
          consumerTags,
          refactorType,
          cleanOld,
          cleanNew,
          consumerPath
        );
        allPatches.push(...astroTemplatePatches);
      } else if (ext === '.tsx' || ext === '.jsx') {
        const jsxPatches = scanJsxProps(
          content,
          consumerTags,
          refactorType,
          cleanOld,
          cleanNew,
          consumerPath
        );
        allPatches.push(...jsxPatches);
      }
    } catch {
      // Ignore unparseable consumer file
    }
  }

  return {
    component: absComponentPath,
    refactorType,
    oldName: cleanOld,
    newName: cleanNew,
    totalConsumersAudited: consumerFiles.size,
    totalPatches: allPatches.length,
    patches: allPatches,
    _meta: {
      framework: 'multi-framework',
      version: STRATA_VERSION,
    },
  };
}
