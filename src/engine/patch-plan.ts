import { promises as fs, existsSync } from 'node:fs';
import { basename, extname, resolve } from 'node:path';
import { parse as parseDom, NodeTypes, type ElementNode, type RootNode, type TemplateChildNode } from '@vue/compiler-dom';
import { parseSfc } from './splitter';
import { getComponentTree } from './tree';
import { findProjectRoot } from './path-resolver';
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
  const oldKebab = toKebabCase(oldName);
  const oldCamel = toCamelCase(oldName);
  const newKebab = newName ? toKebabCase(newName) : '';
  const newCamel = newName ? toCamelCase(newName) : '';

  let ast: RootNode;
  try {
    ast = parseDom(templateContent);
  } catch {
    return patches;
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

          // Prop renaming or removal
          if (refactorType === 'rename_prop' || refactorType === 'remove_prop') {
            if (prop.type === NodeTypes.ATTRIBUTE) {
              // Static attribute e.g. title="Hello"
              if (prop.name === oldKebab || prop.name === oldCamel || prop.name === oldName) {
                if (refactorType === 'rename_prop' && newName) {
                  const targetReplacementAttr = prop.name.includes('-') ? newKebab : newCamel;
                  const newSnippet = rawPropText.replace(
                    new RegExp(`^${prop.name}`),
                    targetReplacementAttr
                  );
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
            } else if (prop.type === NodeTypes.DIRECTIVE && (prop.name === 'bind' || !prop.name)) {
              // Dynamic prop binding e.g. :title="myTitle" or v-bind:title="myTitle"
              const argContent = prop.arg && 'content' in prop.arg ? prop.arg.content : '';
              if (argContent === oldKebab || argContent === oldCamel || argContent === oldName) {
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
            }
          }

          // Event renaming or removal
          if (refactorType === 'rename_event' || refactorType === 'remove_event') {
            if (prop.type === NodeTypes.DIRECTIVE && prop.name === 'on') {
              const eventName = prop.arg && 'content' in prop.arg ? prop.arg.content : '';
              if (eventName === oldKebab || eventName === oldCamel || eventName === oldName) {
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
            }
          }
        }
      }

      el.children?.forEach(walk);
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
  const oldCamel = toCamelCase(oldName);
  const newCamel = newName ? toCamelCase(newName) : '';
  const lines = code.split('\n');

  for (let i = 0; i < lines.length; i++) {
    const lineContent = lines[i];
    const lineNum = i + 1;

    for (const tag of targetTags) {
      if (!lineContent.includes(`<${tag}`) && !lineContent.includes(`<${tag} `)) {
        continue;
      }

      // Prop or event attribute pattern in JSX
      const attrPattern = new RegExp(`\\b(${oldName}|${oldCamel})(=|\\s|>|$)`, 'g');
      let match: RegExpExecArray | null;

      while ((match = attrPattern.exec(lineContent)) !== null) {
        const colNum = match.index + 1;
        const matchedProp = match[1];

        if (refactorType === 'rename_prop' || refactorType === 'rename_event') {
          if (newName) {
            patches.push({
              file: filePath,
              line: lineNum,
              column: colNum,
              targetTag: tag,
              oldSnippet: matchedProp,
              newSnippet: newCamel,
              description: `Rename JSX attribute "${matchedProp}" to "${newCamel}" on <${tag}>`,
            });
          }
        } else if (refactorType === 'remove_prop' || refactorType === 'remove_event') {
          // Identify full JSX attribute expression
          const fullAttrRegex = new RegExp(`\\b${matchedProp}(?:=(?:\{[^}]*\}|"[^"]*"|'[^']*'))?`, 'g');
          fullAttrRegex.lastIndex = match.index;
          const fullMatch = fullAttrRegex.exec(lineContent);
          const oldSnippet = fullMatch ? fullMatch[0] : matchedProp;

          patches.push({
            file: filePath,
            line: lineNum,
            column: colNum,
            targetTag: tag,
            oldSnippet,
            newSnippet: '',
            description: `Remove JSX attribute "${matchedProp}" on <${tag}>`,
          });
        }
      }
    }
  }

  return patches;
}

/**
 * Generates an automated, prescriptive AST patch plan across all upward consumers of a component.
 */
export async function generatePatchPlan(options: PatchPlanOptions): Promise<PatchPlanResult> {
  const { componentPath, refactorType, oldName, newName, targetPath } = options;
  const projectRoot = findProjectRoot(componentPath) ?? targetPath ?? process.cwd();
  const absComponentPath = resolve(componentPath);

  const compName = basename(absComponentPath, extname(absComponentPath));
  const targetTags = getCandidateTagNames(compName);

  // 1. Resolve upward tree to get all consumer components (blast radius)
  const treeResult = await getComponentTree({
    entryPath: absComponentPath,
    direction: 'up',
    targetPath: projectRoot,
  });

  const consumerFiles = new Set<string>();

  function collectConsumerPaths(node: typeof treeResult.root): void {
    if (node.path && resolve(node.path) !== absComponentPath) {
      consumerFiles.add(node.path);
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
      const content = await fs.readFile(consumerPath, 'utf-8');
      const ext = extname(consumerPath).toLowerCase();

      if (ext === '.vue') {
        const sfc = parseSfc(content, consumerPath);
        if (sfc.template) {
          const templatePatches = scanVueTemplateProps(
            sfc.template.content,
            sfc.template.loc.start.line,
            sfc.template.loc.start.column,
            targetTags,
            refactorType,
            oldName,
            newName,
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
          targetTags,
          refactorType,
          oldName,
          newName,
          consumerPath
        );
        allPatches.push(...astroTemplatePatches);
      } else if (ext === '.tsx' || ext === '.jsx') {
        const jsxPatches = scanJsxProps(
          content,
          targetTags,
          refactorType,
          oldName,
          newName,
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
    oldName,
    newName,
    totalConsumersAudited: consumerFiles.size,
    totalPatches: allPatches.length,
    patches: allPatches,
    _meta: {
      framework: 'multi-framework',
      version: '0.7.3',
    },
  };
}
