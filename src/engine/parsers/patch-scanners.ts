import { parse as parseDom, NodeTypes, type ElementNode, type RootNode, type TemplateChildNode } from '@vue/compiler-dom';
import ts from 'typescript';
import { parseAstro } from '../astro-sfc';
import { escapeRegExp } from '../patterns';
import { isVueTagBoundLocally, vueElementBindings } from '../template';
import type { ComponentPatchItem, PatchRefactorType } from '../../types';

/**
 * Converts a PascalCase or camelCase string to kebab-case.
 */
export function toKebabCase(str: string): string {
  return str
    .replace(/([a-z0-9])([A-Z])/g, '$1-$2')
    .replace(/[\s_]+/g, '-')
    .toLowerCase();
}

/**
 * Converts a kebab-case string to camelCase.
 */
export function toCamelCase(str: string): string {
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
export function getCandidateTagNames(compName: string): Set<string> {
  const set = new Set<string>();
  set.add(compName);
  set.add(toKebabCase(compName));
  set.add(toCamelCase(compName));
  return set;
}

/**
 * Traverses Vue AST and locates exact attribute locations for patching.
 */
export function scanVueTemplateProps(
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
  const removedElements = new Set<ElementNode>();
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
    if (prop.arg && prop.arg.isStatic === false) return; // Dynamic arguments (:[$prop]) cannot be statically renamed
    const argContent = prop.arg && 'content' in prop.arg ? prop.arg.content : '';
    if (!matchVueProp(argContent, cleanOld)) return;

    if (refactorType === 'rename_prop' && newName) {
      const targetReplacementAttr = argContent.includes('-') ? newKebab : newCamel;
      let newSnippet = rawPropText.replace(
        new RegExp(`(^v-bind:|^:)${escapeRegExp(argContent)}(?=[.=\\s]|$)`),
        `$1${targetReplacementAttr}`
      );
      if (!rawPropText.includes('=')) newSnippet += `="${toCamelCase(argContent)}"`;

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
    if (prop.arg && prop.arg.isStatic === false) return; // Dynamic events (@[$event]) cannot be statically renamed
    const eventName = prop.arg && 'content' in prop.arg ? prop.arg.content : '';
    if (!matchVueEvent(eventName, cleanOld)) return;

    if (refactorType === 'rename_event' && newName) {
      const targetReplacementEvent = eventName.includes('-') ? newKebab : newCamel;
      const newSnippet = rawPropText.replace(
        new RegExp(`(^v-on:|^@)${escapeRegExp(eventName)}(?=[.=\\s]|$)`),
        `$1${targetReplacementEvent}`
      );

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
    if (prop.type === NodeTypes.DIRECTIVE && prop.name === 'model') {
      if (prop.arg && prop.arg.isStatic === false) return;
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
      return;
    }

    if (
      (prop.type === NodeTypes.DIRECTIVE && prop.name === 'bind' && prop.arg && 'content' in prop.arg) ||
      (prop.type === NodeTypes.ATTRIBUTE)
    ) {
      if (prop.type === NodeTypes.DIRECTIVE && prop.arg && prop.arg.isStatic === false) return;
      const propName = prop.type === NodeTypes.ATTRIBUTE ? prop.name : prop.arg.content;
      const isDefaultModel = propName === 'model-value' || propName === 'modelValue';
      const matches =
        matchVueProp(propName, cleanOld) ||
        (isDefaultModel && (cleanOld === 'modelValue' || cleanOld === 'model'));

      if (!matches) return;

      if (refactorType === 'rename_model' && newName) {
        const targetReplacement = propName.includes('-') ? newKebab : newCamel;
        let newSnippet: string;
        if (prop.type === NodeTypes.ATTRIBUTE) {
          newSnippet = rawPropText.replace(new RegExp(`^${escapeRegExp(propName)}\\b`), targetReplacement);
        } else {
          newSnippet = rawPropText.replace(
            new RegExp(`(:|v-bind:)${escapeRegExp(propName)}\\b`),
            `$1${targetReplacement}`
          );
        }
        patches.push({
          file: filePath,
          line: absLine,
          column: absCol,
          targetTag: el.tag,
          oldSnippet: rawPropText,
          newSnippet,
          description: `Rename model prop binding "${propName}" to "${targetReplacement}" on <${el.tag}>`,
        });
      } else if (refactorType === 'remove_model') {
        patches.push({
          file: filePath,
          line: absLine,
          column: absCol,
          targetTag: el.tag,
          oldSnippet: rawPropText,
          newSnippet: '',
          description: `Remove model prop binding "${propName}" on <${el.tag}>`,
        });
      }
      return;
    }

    if (prop.type === NodeTypes.DIRECTIVE && prop.name === 'on' && prop.arg && 'content' in prop.arg) {
      if (prop.arg.isStatic === false) return;
      const eventName = prop.arg.content;
      if (eventName.startsWith('update:')) {
        const eventModelPart = eventName.slice(7);
        const isDefaultModel = eventModelPart === 'model-value' || eventModelPart === 'modelValue';
        const matches =
          matchVueProp(eventModelPart, cleanOld) ||
          (isDefaultModel && (cleanOld === 'modelValue' || cleanOld === 'model'));

        if (!matches) return;

        if (refactorType === 'rename_model' && newName) {
          const targetReplacement = eventModelPart.includes('-') ? newKebab : newCamel;
          const newSnippet = rawPropText.replace(
            new RegExp(`(@|v-on:)(update:)${escapeRegExp(eventModelPart)}\\b`),
            `$1$2${targetReplacement}`
          );
          patches.push({
            file: filePath,
            line: absLine,
            column: absCol,
            targetTag: el.tag,
            oldSnippet: rawPropText,
            newSnippet,
            description: `Rename model update event "@update:${eventModelPart}" to "@update:${targetReplacement}" on <${el.tag}>`,
          });
        } else if (refactorType === 'remove_model') {
          patches.push({
            file: filePath,
            line: absLine,
            column: absCol,
            targetTag: el.tag,
            oldSnippet: rawPropText,
            newSnippet: '',
            description: `Remove model update event "@update:${eventModelPart}" on <${el.tag}>`,
          });
        }
      }
    }
  }

  function handleSlotDirective(
    prop: any,
    targetTag: string,
    absLine: number,
    absCol: number,
    rawPropText: string
  ): void {
    if (prop.name !== 'slot' || (prop.arg && !prop.arg.isStatic)) return;
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

  function walk(node: RootNode | TemplateChildNode, outer: ReadonlySet<string>): void {
    let scope = outer;
    if (node.type === NodeTypes.ELEMENT) {
      const el = node as ElementNode;
      if (removedElements.has(el)) return;
      scope = vueElementBindings(el, outer);
      const tagMatches = !isVueTagBoundLocally(el.tag, scope) && (targetTags.has(el.tag) || targetTags.has(toKebabCase(el.tag)));

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
            handleModelDirective(prop, el, absLine, absCol, rawPropText);
          } else if (refactorType === 'rename_slot') {
            if (prop.type === NodeTypes.DIRECTIVE) {
              handleSlotDirective(prop, el.tag, absLine, absCol, rawPropText);
            }
          } else if (refactorType === 'remove_slot') {
            if (prop.type === NodeTypes.DIRECTIVE && prop.name === 'slot' && (!prop.arg || ('isStatic' in prop.arg && prop.arg.isStatic))) {
              const slotName = prop.arg && 'content' in prop.arg ? prop.arg.content : 'default';
              if (matchVueProp(slotName, cleanOld) || (slotName === 'default' && cleanOld === 'slot')) {
                if (el.props.length > 1 || !el.children || el.children.length === 0) {
                  handleSlotDirective(prop, el.tag, absLine, absCol, rawPropText);
                } else {
                  patches.push({
                    file: filePath,
                    line: templateStartLine + el.loc.start.line - 1,
                    column: el.loc.start.line === 1 ? templateStartCol + el.loc.start.column - 1 : el.loc.start.column,
                    targetTag: el.tag,
                    oldSnippet: el.loc.source,
                    newSnippet: '',
                    description: `Remove direct slot "${slotName}" subtree on <${el.tag}>`,
                  });
                  return;
                }
              }
            }
          }
        }

        if (refactorType === 'rename_slot' || refactorType === 'remove_slot') {
          for (const child of el.children || []) {
            if (child.type === NodeTypes.ELEMENT && (child as ElementNode).tag === 'template') {
              const templateChild = child as ElementNode;
              for (const tProp of templateChild.props) {
                if (tProp.type === NodeTypes.DIRECTIVE && tProp.name === 'slot' && (!tProp.arg || ('isStatic' in tProp.arg && tProp.arg.isStatic))) {
                  const slotName = tProp.arg && 'content' in tProp.arg ? tProp.arg.content : 'default';
                  const matches =
                    matchVueProp(slotName, cleanOld) ||
                    (slotName === 'default' && (cleanOld === 'default' || cleanOld === 'slot'));
                  if (!matches) continue;

                  if (refactorType === 'rename_slot' && newName) {
                    const tLine = templateStartLine + tProp.loc.start.line - 1;
                    const tCol =
                      tProp.loc.start.line === 1
                        ? templateStartCol + tProp.loc.start.column - 1
                        : tProp.loc.start.column;
                    handleSlotDirective(tProp, el.tag, tLine, tCol, tProp.loc.source);
                  } else if (refactorType === 'remove_slot') {
                    removedElements.add(templateChild);
                    const elemLine = templateStartLine + templateChild.loc.start.line - 1;
                    const elemCol =
                      templateChild.loc.start.line === 1
                        ? templateStartCol + templateChild.loc.start.column - 1
                        : templateChild.loc.start.column;
                    patches.push({
                      file: filePath,
                      line: elemLine,
                      column: elemCol,
                      targetTag: el.tag,
                      oldSnippet: templateChild.loc.source,
                      newSnippet: '',
                      description: `Remove slot "${slotName}" template subtree on <${el.tag}>`,
                    });
                  }
                }
              }
            }
          }
        }
      }
    }

    if ('children' in node && Array.isArray((node as any).children)) {
      (node as any).children.forEach((child: TemplateChildNode) => walk(child, scope));
    }
  }

  walk(ast, new Set());
  return patches;
}

export interface TsxLikeScanOptions {
  kindLabel: string;
  preserveKebabCase: boolean;
  maskAstroFrontmatter?: boolean;
  resolvedTagStarts?: ReadonlySet<number>;
}

/**
 * Shared TSX-AST prop scanner for JSX, Astro template, and Svelte template usages.
 */
export function scanTsxLikeProps(
  code: string,
  targetTags: Set<string>,
  refactorType: PatchRefactorType,
  oldName: string,
  newName: string | undefined,
  filePath: string,
  options: TsxLikeScanOptions
): ComponentPatchItem[] {
  const patches: ComponentPatchItem[] = [];
  const cleanOld = cleanIdentifier(oldName);
  const cleanNew = newName ? cleanIdentifier(newName) : undefined;
  const renames = refactorType.startsWith('rename_');

  let scannableCode = code;
  if (options.maskAstroFrontmatter) {
    // Mask frontmatter without moving any source offsets, including CRLF and comments.
    const template = parseAstro(code, filePath).template;
    const offset = template?.loc.start.offset ?? 0;
    scannableCode = code.slice(0, offset).replace(/[^\r\n]/g, ' ') + code.slice(offset);
  }

  const sf = ts.createSourceFile(filePath, scannableCode, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);

  function visit(node: ts.Node): void {
    if (ts.isJsxOpeningElement(node) || ts.isJsxSelfClosingElement(node)) {
      const tag = node.tagName.getText(sf);
      if (options.resolvedTagStarts
        ? options.resolvedTagStarts.has(node.getStart(sf))
        : targetTags.has(tag) || targetTags.has(toKebabCase(tag))) {
        for (const attr of node.attributes.properties) {
          const attrName = ts.isJsxAttribute(attr) ? attr.name.getText(sf) : '';
          if (!ts.isJsxAttribute(attr) || !matchVueProp(attrName, cleanOld)) continue;
          if (renames && !cleanNew) continue;
          const target = renames ? attr.name : attr;
          const position = sf.getLineAndCharacterOfPosition(target.getStart(sf));
          const replacementName = renames
            ? (options.preserveKebabCase && attrName.includes('-') ? toKebabCase(cleanNew!) : toCamelCase(cleanNew!))
            : '';
          patches.push({
            file: filePath,
            line: position.line + 1,
            column: position.character + 1,
            targetTag: tag,
            oldSnippet: target.getText(sf),
            newSnippet: replacementName,
            description: `${renames ? 'Rename' : 'Remove'} ${options.kindLabel} "${attrName}" on <${tag}>`,
          });
        }
      }
    }
    ts.forEachChild(node, visit);
  }
  visit(sf);

  return patches;
}
