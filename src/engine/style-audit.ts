import { readSourceFile } from './source-file';
import { escapeRegExp } from './patterns';
import { promises as fs } from 'node:fs';
import { extname, isAbsolute, relative, resolve } from 'node:path';
import { collectFiles } from './collector';
import {
  parse as parseDom,
  NodeTypes,
  type ElementNode,
  type RootNode,
  type TemplateChildNode,
} from '@vue/compiler-dom';
import { parseSfc } from './splitter';
import { parseAstro } from './astro-sfc';
import ts from 'typescript';
import type {
  A11yViolation,
  ArbitraryTokenViolation,
  AuditDesignTokensOptions,
  DesignSystemAuditResult,
} from '../types';

const COMPONENT_EXTENSIONS = new Set(['.vue', '.tsx', '.jsx', '.astro', '.html']);

const MULTILINE_CLASS_REGEX = /(?:class|className|:class)=["'`]([^"'`]+)["'`]/gs;

interface ExtractedAttribute {
  isStatic: boolean;
  value: string;
  line: number;
  column: number;
}

/**
 * Helper to calculate line number from character offset in content.
 */
function getLineFromOffset(content: string, offset: number): number {
  let line = 1;
  for (let i = 0; i < offset && i < content.length; i++) {
    if (content[i] === '\n') line++;
  }
  return line;
}

/**
 * Extracts attribute from Vue ElementNode across static and bound directives.
 */
function getVueAttribute(el: ElementNode, name: string, startLine: number): ExtractedAttribute | null {
  const lowerName = name.toLowerCase();
  for (const prop of el.props) {
    if (prop.type === NodeTypes.ATTRIBUTE) {
      if (prop.name.toLowerCase() === lowerName) {
        return {
          isStatic: true,
          value: prop.value ? prop.value.content : '',
          line: startLine + prop.loc.start.line - 1,
          column: prop.loc.start.column,
        };
      }
    } else if (prop.type === NodeTypes.DIRECTIVE && prop.name === 'bind') {
      const arg = prop.arg && 'content' in prop.arg ? prop.arg.content.toLowerCase() : '';
      if (arg === lowerName) {
        return {
          isStatic: false,
          value: prop.exp && 'content' in prop.exp ? prop.exp.content : '',
          line: startLine + prop.loc.start.line - 1,
          column: prop.loc.start.column,
        };
      }
    }
  }
  return null;
}

/**
 * Checks whether an element or node contains accessible text content.
 */
function hasAccessibleText(node: ElementNode | RootNode): boolean {
  for (const child of node.children || []) {
    if (child.type === NodeTypes.TEXT) {
      if (child.content && child.content.trim().length > 0) return true;
    } else if (child.type === NodeTypes.INTERPOLATION) {
      return true; // Dynamic text binding {{ message }}
    } else if (child.type === NodeTypes.ELEMENT) {
      const el = child as ElementNode;
      const tag = el.tag.toLowerCase();
      const isIcon = tag === 'svg' || tag === 'i' || /icon/i.test(tag);
      if (!isIcon) {
        if (hasAccessibleText(el)) return true;
      } else {
        // Icon with an explicit aria-label can provide an accessible name
        const iconAria = getVueAttribute(el, 'aria-label', 1);
        if (iconAria && iconAria.value.trim().length > 0) return true;
      }
    }
  }
  return false;
}

/**
 * Traverses Vue AST and audits accessibility and design system tokens.
 */
function auditVueTemplateA11y(
  templateContent: string,
  templateStartLine: number,
  templateStartCol: number,
  relFile: string
): A11yViolation[] {
  let ast: RootNode;
  try {
    ast = parseDom(templateContent);
  } catch {
    return [];
  }

  const violations: A11yViolation[] = [];
  const definedIds = new Set<string>();
  let hasDynamicId = false;
  const labelsWithFor = new Map<string, { line: number; col: number; text: string }>();
  let hasDynamicLabelFor = false;

  // Pass 1: Collect defined element IDs and <label for="..."> associations
  function collectIdsAndLabels(node: RootNode | TemplateChildNode): void {
    if (node.type === NodeTypes.ELEMENT) {
      const el = node as ElementNode;
      const tag = el.tag.toLowerCase();

      for (const prop of el.props) {
        if (prop.type === NodeTypes.ATTRIBUTE) {
          if (prop.name === 'id' && prop.value?.content) {
            definedIds.add(prop.value.content.trim());
          } else if ((prop.name === 'for' || prop.name === 'htmlFor') && prop.value?.content) {
            if (tag === 'label') {
              labelsWithFor.set(prop.value.content.trim(), {
                line: templateStartLine + el.loc.start.line - 1,
                col: el.loc.start.column,
                text: el.loc.source,
              });
            }
          }
        } else if (prop.type === NodeTypes.DIRECTIVE && prop.name === 'bind') {
          const arg = prop.arg && 'content' in prop.arg ? prop.arg.content : '';
          if (arg === 'id') hasDynamicId = true;
          if ((arg === 'for' || arg === 'htmlFor') && tag === 'label') hasDynamicLabelFor = true;
        }
      }
    }

    if ('children' in node && Array.isArray((node as any).children)) {
      (node as any).children.forEach(collectIdsAndLabels);
    }
  }

  collectIdsAndLabels(ast);

  // Pass 2: Audit elements with ancestor label tracking
  function inspectNode(node: RootNode | TemplateChildNode, ancestorStack: ElementNode[]): void {
    if (node.type === NodeTypes.ELEMENT) {
      const el = node as ElementNode;
      const tag = el.tag.toLowerCase();
      const lineNum = templateStartLine + el.loc.start.line - 1;
      const colNum = el.loc.start.column;
      const elementSnippet = el.loc.source.slice(0, 50).replace(/\s+/g, ' ');

      // A11y Check A: Missing alt on images
      if (tag === 'img' || tag === 'nuxtimg' || tag === 'image' || tag === 'nuxt-img') {
        const altAttr = getVueAttribute(el, 'alt', templateStartLine);
        const ariaHidden = getVueAttribute(el, 'aria-hidden', templateStartLine);
        const isDecorativeAria = ariaHidden?.isStatic && ariaHidden.value.toLowerCase() === 'true';

        if (!altAttr && !isDecorativeAria) {
          violations.push({
            file: relFile,
            line: lineNum,
            column: colNum,
            element: elementSnippet,
            ruleId: 'a11y/alt-text',
            certainty: 'confirmed',
            severity: 'error',
            issue: 'Image is missing an alt attribute.',
            recommendation: 'Add alt="..." describing the visual content or alt="" if purely decorative.',
          });
        }
      }

      // A11y Check B: Form input labeling (Input, Select, Textarea)
      if (tag === 'input' || tag === 'select' || tag === 'textarea') {
        const typeAttr = getVueAttribute(el, 'type', templateStartLine);
        const inputType = typeAttr?.isStatic ? typeAttr.value.toLowerCase() : 'text';
        const isIgnoredType = tag === 'input' && ['hidden', 'submit', 'button', 'reset', 'image'].includes(inputType);

        if (!isIgnoredType) {
          const ariaLabel = getVueAttribute(el, 'aria-label', templateStartLine);
          const ariaLabelledBy = getVueAttribute(el, 'aria-labelledby', templateStartLine);
          const idAttr = getVueAttribute(el, 'id', templateStartLine);
          const enclosingLabel = ancestorStack.slice().reverse().find(p => p.tag.toLowerCase() === 'label');
          const isWrappedInLabelWithText = enclosingLabel ? hasAccessibleText(enclosingLabel) : false;

          // Check 1: Empty aria-label
          if (ariaLabel && ariaLabel.isStatic && ariaLabel.value.trim() === '') {
            violations.push({
              file: relFile,
              line: lineNum,
              column: colNum,
              element: elementSnippet,
              ruleId: 'a11y/empty-aria-label',
              certainty: 'confirmed',
              severity: 'error',
              issue: 'Form input has an empty aria-label.',
              recommendation: 'Provide a meaningful description in aria-label="..." or remove it.',
            });
          }
          // Check 2: aria-labelledby reference existence
          else if (ariaLabelledBy && ariaLabelledBy.isStatic) {
            const referencedIds = ariaLabelledBy.value.trim().split(/\s+/).filter(Boolean);
            const missingIds = referencedIds.filter(id => !definedIds.has(id));

            if (missingIds.length > 0) {
              if (hasDynamicId) {
                violations.push({
                  file: relFile,
                  line: lineNum,
                  column: colNum,
                  element: elementSnippet,
                  ruleId: 'a11y/aria-labelledby-reference',
                  certainty: 'candidate',
                  severity: 'warning',
                  issue: `Element referenced by aria-labelledby="${ariaLabelledBy.value}" not statically found (may be dynamic).`,
                  recommendation: 'Ensure referenced ID exists in template or is generated at runtime.',
                });
              } else {
                violations.push({
                  file: relFile,
                  line: lineNum,
                  column: colNum,
                  element: elementSnippet,
                  ruleId: 'a11y/aria-labelledby-reference',
                  certainty: 'confirmed',
                  severity: 'error',
                  issue: `Element referenced by aria-labelledby="${ariaLabelledBy.value}" does not exist in template.`,
                  recommendation: 'Ensure the referenced element ID exists in the template.',
                });
              }
            }
          }
          // Check 3: Missing label association
          else if (!ariaLabel && !ariaLabelledBy && !isWrappedInLabelWithText) {
            const classAttr = getVueAttribute(el, 'class', templateStartLine);
            const isHiddenFile = tag === 'input' && inputType === 'file' && (classAttr?.value.includes('hidden') || el.props.some(p => p.name === 'hidden'));

            if (enclosingLabel && !isWrappedInLabelWithText) {
              violations.push({
                file: relFile,
                line: lineNum,
                column: colNum,
                element: elementSnippet,
                ruleId: 'a11y/label-has-associated-control',
                certainty: 'confirmed',
                severity: 'error',
                issue: 'Enclosing <label> contains no text content to label this form control.',
                recommendation: 'Add descriptive text inside the <label> or add an aria-label to the input.',
              });
            } else if (idAttr?.isStatic && idAttr.value) {
              const matchingLabel = labelsWithFor.has(idAttr.value.trim());
              if (!matchingLabel) {
                if (hasDynamicLabelFor) {
                  violations.push({
                    file: relFile,
                    line: lineNum,
                    column: colNum,
                    element: elementSnippet,
                    ruleId: 'a11y/label-has-associated-control',
                    certainty: 'candidate',
                    severity: 'warning',
                    issue: `Form input with id "${idAttr.value}" has no static matching <label for="${idAttr.value}"> (may match dynamic label).`,
                    recommendation: `Ensure a <label for="${idAttr.value}"> is provided.`,
                  });
                } else {
                  violations.push({
                    file: relFile,
                    line: lineNum,
                    column: colNum,
                    element: elementSnippet,
                    ruleId: 'a11y/label-has-associated-control',
                    certainty: 'confirmed',
                    severity: 'error',
                    issue: `Form input with id "${idAttr.value}" is missing an associated <label for="${idAttr.value}"> or aria-label.`,
                    recommendation: `Add a corresponding <label for="${idAttr.value}"> tag or add aria-label="...".`,
                  });
                }
              }
            } else if (idAttr && !idAttr.isStatic) {
              violations.push({
                file: relFile,
                line: lineNum,
                column: colNum,
                element: elementSnippet,
                ruleId: 'a11y/label-has-associated-control',
                certainty: 'candidate',
                severity: 'warning',
                issue: 'Form input has dynamic :id binding; ensure corresponding <label :for="..."> exists.',
                recommendation: 'Ensure dynamic label association is properly bound.',
              });
            } else if (isHiddenFile) {
              violations.push({
                file: relFile,
                line: lineNum,
                column: colNum,
                element: elementSnippet,
                ruleId: 'a11y/hidden-input-trigger',
                certainty: 'candidate',
                severity: 'warning',
                issue: 'Hidden file input should be triggered by an associated <label for="..."> or accessible button.',
                recommendation: 'Ensure an accessible button or label triggers this file input.',
              });
            } else {
              violations.push({
                file: relFile,
                line: lineNum,
                column: colNum,
                element: elementSnippet,
                ruleId: 'a11y/label-has-associated-control',
                certainty: 'confirmed',
                severity: 'error',
                issue: 'Form input missing aria-label, aria-labelledby, or associated <label for="...">.',
                recommendation: 'Add aria-label="..." or connect with a corresponding <label for="..."> tag.',
              });
            }
          }
        }
      }

      // A11y Check C: Interactive buttons accessible name
      if (tag === 'button') {
        const ariaLabel = getVueAttribute(el, 'aria-label', templateStartLine);
        const ariaLabelledBy = getVueAttribute(el, 'aria-labelledby', templateStartLine);
        const hasText = hasAccessibleText(el);

        if (ariaLabel && ariaLabel.isStatic && ariaLabel.value.trim() === '') {
          violations.push({
            file: relFile,
            line: lineNum,
            column: colNum,
            element: elementSnippet,
            ruleId: 'a11y/empty-aria-label',
            certainty: 'confirmed',
            severity: 'error',
            issue: 'Button has an empty aria-label.',
            recommendation: 'Provide a meaningful accessible label in aria-label="..." or include text inside the button.',
          });
        } else if (!ariaLabel && !ariaLabelledBy && !hasText) {
          violations.push({
            file: relFile,
            line: lineNum,
            column: colNum,
            element: '<button> (icon-only)',
            ruleId: 'a11y/button-has-accessible-name',
            certainty: 'confirmed',
            severity: 'error',
            issue: 'Interactive button contains only icon/svg without accessible label.',
            recommendation: 'Add aria-label="..." to the button or include an inner <span class="sr-only">Label</span>.',
          });
        }
      }

      const nextStack = [...ancestorStack, el];
      for (const child of el.children || []) {
        inspectNode(child, nextStack);
      }
      return;
    }

    if ('children' in node && Array.isArray((node as any).children)) {
      for (const child of (node as any).children) {
        inspectNode(child, ancestorStack);
      }
    }
  }

  inspectNode(ast, []);
  return violations;
}

/**
 * Traverses JSX/TSX AST and audits accessibility.
 */
function auditJsxA11y(content: string, relFile: string): A11yViolation[] {
  const violations: A11yViolation[] = [];
  const sf = ts.createSourceFile(relFile, content, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  const definedIds = new Set<string>();
  const labelsWithFor = new Map<string, boolean>();

  // Pass 1: Collect IDs and labels
  function collect(node: ts.Node): void {
    if (ts.isJsxElement(node) || ts.isJsxSelfClosingElement(node)) {
      const attrs = ts.isJsxElement(node) ? node.openingElement.attributes.properties : node.attributes.properties;
      const tag = (ts.isJsxElement(node) ? node.openingElement.tagName.getText(sf) : node.tagName.getText(sf)).toLowerCase();

      for (const p of attrs) {
        if (ts.isJsxAttribute(p)) {
          const name = p.name.getText(sf);
          const val = p.initializer && ts.isStringLiteral(p.initializer) ? p.initializer.text.trim() : '';
          if (name === 'id' && val) definedIds.add(val);
          if (tag === 'label' && (name === 'for' || name === 'htmlFor') && val) {
            labelsWithFor.set(val, true);
          }
        }
      }
    }
    ts.forEachChild(node, collect);
  }
  collect(sf);

  // Pass 2: Audit JSX elements
  function inspect(node: ts.Node, insideLabel: boolean): void {
    if (ts.isJsxElement(node) || ts.isJsxSelfClosingElement(node)) {
      const isElement = ts.isJsxElement(node);
      const tag = (isElement ? node.openingElement.tagName.getText(sf) : node.tagName.getText(sf)).toLowerCase();
      const attrs = isElement ? node.openingElement.attributes.properties : node.attributes.properties;
      const pos = sf.getLineAndCharacterOfPosition(node.getStart(sf));
      const lineNum = pos.line + 1;
      const colNum = pos.character + 1;
      const elementSnippet = `<${tag}>`;

      const getAttr = (attrName: string) => {
        for (const p of attrs) {
          if (ts.isJsxAttribute(p) && p.name.getText(sf).toLowerCase() === attrName.toLowerCase()) {
            if (!p.initializer) return { isStatic: true, value: '' };
            if (ts.isStringLiteral(p.initializer)) return { isStatic: true, value: p.initializer.text };
            return { isStatic: false, value: p.initializer.getText(sf) };
          }
        }
        return null;
      };

      if (tag === 'img' || tag === 'image') {
        const altAttr = getAttr('alt');
        const ariaHidden = getAttr('aria-hidden');
        if (!altAttr && ariaHidden?.value !== 'true') {
          violations.push({
            file: relFile,
            line: lineNum,
            column: colNum,
            element: elementSnippet,
            ruleId: 'a11y/alt-text',
            certainty: 'confirmed',
            severity: 'error',
            issue: 'Image is missing an alt attribute.',
            recommendation: 'Add alt="..." describing the visual content or alt="" if purely decorative.',
          });
        }
      }

      if (tag === 'input' || tag === 'select' || tag === 'textarea') {
        const typeAttr = getAttr('type');
        const inputType = typeAttr?.value.toLowerCase() || 'text';
        if (tag !== 'input' || !['hidden', 'submit', 'button', 'reset', 'image'].includes(inputType)) {
          const ariaLabel = getAttr('aria-label');
          const ariaLabelledBy = getAttr('aria-labelledby');
          const idAttr = getAttr('id');

          if (ariaLabel && ariaLabel.isStatic && ariaLabel.value.trim() === '') {
            violations.push({
              file: relFile,
              line: lineNum,
              column: colNum,
              element: elementSnippet,
              ruleId: 'a11y/empty-aria-label',
              certainty: 'confirmed',
              severity: 'error',
              issue: 'Form input has an empty aria-label.',
              recommendation: 'Provide a meaningful description in aria-label="..." or remove it.',
            });
          } else if (!ariaLabel && !ariaLabelledBy && !insideLabel) {
            if (idAttr?.isStatic && idAttr.value) {
              if (!labelsWithFor.has(idAttr.value.trim())) {
                violations.push({
                  file: relFile,
                  line: lineNum,
                  column: colNum,
                  element: elementSnippet,
                  ruleId: 'a11y/label-has-associated-control',
                  certainty: 'confirmed',
                  severity: 'error',
                  issue: `Form input with id "${idAttr.value}" is missing an associated <label for="${idAttr.value}"> or aria-label.`,
                  recommendation: `Add a corresponding <label for="${idAttr.value}"> tag or add aria-label="...".`,
                });
              }
            } else {
              violations.push({
                file: relFile,
                line: lineNum,
                column: colNum,
                element: elementSnippet,
                ruleId: 'a11y/label-has-associated-control',
                certainty: 'confirmed',
                severity: 'error',
                issue: 'Form input missing aria-label, aria-labelledby, or associated <label for="...">.',
                recommendation: 'Add aria-label="..." or connect with a corresponding <label for="..."> tag.',
              });
            }
          }
        }
      }

      if (tag === 'button') {
        const ariaLabel = getAttr('aria-label');
        const ariaLabelledBy = getAttr('aria-labelledby');
        let hasText = false;
        if (isElement) {
          for (const child of node.children) {
            if (ts.isJsxText(child) && child.text.trim().length > 0) hasText = true;
            if (ts.isJsxExpression(child)) hasText = true;
          }
        }
        if (ariaLabel && ariaLabel.isStatic && ariaLabel.value.trim() === '') {
          violations.push({
            file: relFile,
            line: lineNum,
            column: colNum,
            element: elementSnippet,
            ruleId: 'a11y/empty-aria-label',
            certainty: 'confirmed',
            severity: 'error',
            issue: 'Button has an empty aria-label.',
            recommendation: 'Provide a meaningful accessible label in aria-label="..." or include text inside the button.',
          });
        } else if (!ariaLabel && !ariaLabelledBy && !hasText && isElement) {
          violations.push({
            file: relFile,
            line: lineNum,
            column: colNum,
            element: '<button> (icon-only)',
            ruleId: 'a11y/button-has-accessible-name',
            certainty: 'confirmed',
            severity: 'error',
            issue: 'Interactive button contains only icon/svg without accessible label.',
            recommendation: 'Add aria-label="..." to the button or include an inner <span class="sr-only">Label</span>.',
          });
        }
      }

      const nextInsideLabel = insideLabel || tag === 'label';
      ts.forEachChild(node, child => inspect(child, nextInsideLabel));
      return;
    }

    ts.forEachChild(node, child => inspect(child, insideLabel));
  }

  inspect(sf, false);
  return violations;
}

/**
 * Performs design system and accessibility static AST audits across template and JSX code:
 * 1. Arbitrary Tailwind tokens (hardcoded hex colors, arbitrary margins/paddings/widths)
 * 2. Visual radius token distribution and fragmentation
 * 3. Fundamental accessibility (a11y) issues: icon-only buttons, missing input labels, missing img alt
 */
export async function auditDesignTokens(
  options: AuditDesignTokensOptions
): Promise<DesignSystemAuditResult> {
  const startTime = Date.now();
  const rootDir = resolve(options.targetPath);
  const absScope = options.scopePath ? resolve(rootDir, options.scopePath) : undefined;
  const allFiles = await collectFiles(rootDir, { excludeDirs: options.excludeDirs });

  const arbitraryTokens: ArbitraryTokenViolation[] = [];
  const radiusDistribution: Record<string, number> = {};
  const a11yViolations: A11yViolation[] = [];
  let totalFilesAudited = 0;

  for (const file of allFiles) {
    const ext = extname(file).toLowerCase();
    if (!COMPONENT_EXTENSIONS.has(ext)) continue;

    if (absScope) {
      const rel = relative(absScope, file);
      if (rel.startsWith('..') || isAbsolute(rel)) {
        continue;
      }
    }

    let content = '';
    try {
      content = await readSourceFile(file);
    } catch {
      continue;
    }

    totalFilesAudited++;
    const relFile = relative(rootDir, file).replace(/\\/g, '/');

    // 1. Multiline Class Token Analysis (Arbitrary Tokens, Radius, Layout Clashes)
    for (const classMatch of content.matchAll(MULTILINE_CLASS_REGEX)) {
      const matchIndex = classMatch.index ?? 0;
      const classStr = classMatch[1];
      const matchLine = getLineFromOffset(content, matchIndex);
      const tokens = classStr.split(/\s+/).filter(Boolean);

      for (const token of tokens) {
        // Arbitrary Color
        if (/(?:text|bg|border|ring|fill|stroke|from|to|via)-\[(#[0-9a-fA-F]+|rgba?\([^\]]+\))\]/.test(token)) {
          arbitraryTokens.push({
            file: relFile,
            line: matchLine,
            token,
            category: 'color',
            recommendation: `Replace arbitrary color '${token}' with a semantic design token (e.g. text-foreground, bg-muted, border-border).`,
          });
        }

        // Arbitrary Spacing
        if (/(?:^|\s)(?:[a-z0-9_-]+:)?(?:p|px|py|pt|pb|pl|pr|m|mx|my|mt|mb|ml|mr|gap|gap-x|gap-y)-\[[0-9]+(?:px|rem|em|%)\]/.test(token)) {
          arbitraryTokens.push({
            file: relFile,
            line: matchLine,
            token,
            category: 'spacing',
            recommendation: `Replace arbitrary spacing '${token}' with Tailwind scale token (e.g. p-3, m-4, gap-2).`,
          });
        }

        // Arbitrary Size (excluding legitimate WCAG touch targets min-h-[44px] and min-w-[44px])
        if (
          /(?:^|\s)(?:[a-z0-9_-]+:)?(?:w|h|min-w|max-w|min-h|max-h|top|bottom|left|right)-\[[0-9]+(?:px|rem|em|%)\]/.test(token) &&
          !/(?:min-h|min-w)-\[44px\]/.test(token)
        ) {
          arbitraryTokens.push({
            file: relFile,
            line: matchLine,
            token,
            category: 'size',
            recommendation: `Replace arbitrary dimension '${token}' with Tailwind sizing class or CSS variable.`,
          });
        }

        // Arbitrary Radius
        if (/(?:^|\s)(?:[a-z0-9_-]+:)?rounded-\[[^\]]+\]/.test(token)) {
          arbitraryTokens.push({
            file: relFile,
            line: matchLine,
            token,
            category: 'radius',
            recommendation: `Replace arbitrary radius '${token}' with standard token (e.g. rounded-md, rounded-lg, rounded-full).`,
          });
        }

        // Track Radius Distribution
        const radiusMatch = token.match(/\brounded(?:-(?:none|sm|md|lg|xl|2xl|3xl|full))?\b/);
        if (radiusMatch && !token.includes('[')) {
          const radToken = radiusMatch[0];
          radiusDistribution[radToken] = (radiusDistribution[radToken] || 0) + 1;
        }
      }

      // Layout Clash: Fixed/Sticky combined with Transform/Backdrop-Filter
      const fixedToken = tokens.find((t) => t === 'fixed' || t === 'sticky');
      const transformToken = tokens.find((t) =>
        /^(?:transform|backdrop-blur(?:-\w+)?|backdrop-filter|filter|scale-\d+|rotate-\d+|-?translate-[xy]-\S+)$/.test(t)
      );
      if (fixedToken && transformToken) {
        arbitraryTokens.push({
          file: relFile,
          line: matchLine,
          token: `${fixedToken} + ${transformToken}`,
          category: 'layout-trap',
          recommendation: `Element combines '${fixedToken}' with '${transformToken}', breaking CSS viewport stacking context. Move fixed element outside the transformed container.`,
        });
      }
    }

    // 2. Structural AST-Based a11y Checks
    let fileViolations: A11yViolation[] = [];
    if (ext === '.vue') {
      const sfc = parseSfc(content, file);
      if (sfc.template?.content) {
        fileViolations = auditVueTemplateA11y(
          sfc.template.content,
          sfc.template.loc.start.line,
          sfc.template.loc.start.column,
          relFile
        );
      }
    } else if (ext === '.html') {
      fileViolations = auditVueTemplateA11y(content, 1, 1, relFile);
    } else if (ext === '.astro') {
      const astro = parseAstro(content, file);
      if (astro.template?.content) {
        fileViolations = auditVueTemplateA11y(
          astro.template.content,
          astro.template.loc.start.line,
          astro.template.loc.start.column,
          relFile
        );
      }
    } else if (ext === '.tsx' || ext === '.jsx') {
      fileViolations = auditJsxA11y(content, relFile);
    }

    a11yViolations.push(...fileViolations);
  }

  return {
    workspaceRoot: rootDir,
    totalFilesAudited,
    arbitraryTokens,
    radiusDistribution,
    a11yViolations,
    _meta: {
      engine: 'in-memory-ast',
      durationMs: Date.now() - startTime,
    },
  };
}

/**
 * Formats DesignSystemAuditResult into token-efficient, human-readable text.
 */
export function formatDesignAuditAsText(result: DesignSystemAuditResult): string {
  const lines: string[] = [
    `=== DESIGN SYSTEM & A11Y AUDIT ===`,
    `Workspace: ${result.workspaceRoot}`,
    `Files Audited: ${result.totalFilesAudited}`,
    `Arbitrary Values Found: ${result.arbitraryTokens.length}`,
    `a11y Violations Found: ${result.a11yViolations.length}`,
    '',
  ];

  // Radius Distribution
  lines.push('Radius Token Distribution (Consistency Check):');
  const radiusEntries = Object.entries(result.radiusDistribution).sort((a, b) => b[1] - a[1]);
  if (radiusEntries.length === 0) {
    lines.push('  (no radius utility classes found)');
  } else {
    for (const [token, count] of radiusEntries) {
      lines.push(`  • ${token}: ${count} usages`);
    }
    if (radiusEntries.length > 4) {
      lines.push('  ⚠️ Warning: High radius fragmentation detected (>4 variations in codebase).');
    }
  }

  // Arbitrary Tokens
  lines.push('');
  lines.push(`Arbitrary Utility Values (${result.arbitraryTokens.length} detected):`);
  if (result.arbitraryTokens.length === 0) {
    lines.push('  ✅ Clean! No arbitrary Tailwind values found.');
  } else {
    for (const at of result.arbitraryTokens.slice(0, 30)) {
      lines.push(`  • [${at.category.toUpperCase()}] ${at.file}:${at.line} \`${at.token}\``);
      lines.push(`    Fix: ${at.recommendation}`);
    }
    if (result.arbitraryTokens.length > 30) {
      lines.push(`  ... and ${result.arbitraryTokens.length - 30} more arbitrary values.`);
    }
  }

  // a11y Violations
  lines.push('');
  lines.push(`Accessibility (a11y) Violations (${result.a11yViolations.length} detected):`);
  if (result.a11yViolations.length === 0) {
    lines.push('  ✅ Clean! No basic a11y issues found.');
  } else {
    for (const a11y of result.a11yViolations.slice(0, 30)) {
      const certaintyTag = a11y.certainty ? `[${a11y.certainty.toUpperCase()}] ` : '';
      const ruleTag = a11y.ruleId ? `[${a11y.ruleId}] ` : '';
      lines.push(`  ⚠️  ${certaintyTag}${ruleTag}${a11y.file}:${a11y.line} — ${a11y.element}`);
      lines.push(`     Issue: ${a11y.issue}`);
      lines.push(`     Fix: ${a11y.recommendation}`);
    }
    if (result.a11yViolations.length > 30) {
      lines.push(`  ... and ${result.a11yViolations.length - 30} more a11y violations.`);
    }
  }

  return lines.join('\n');
}
