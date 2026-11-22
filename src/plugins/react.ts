import { extname } from 'node:path';
import ts from 'typescript';
import { createIdentityVirtualDocument } from './virtual-doc';
import type {
  FrameworkPlugin,
  ProjectionOmission,
  Tier1FileFacts,
  Tier1TemplateComponentUsage,
  VirtualDocument,
} from './types';

const REACT_EXTENSIONS = ['.tsx', '.jsx', '.ts', '.js', '.mts', '.mjs', '.cts', '.cjs'] as const;

function isCustomJsxTag(tagName: string): boolean {
  return /^[A-Z]/.test(tagName) || tagName.includes('.');
}

function extractReactTier1Facts(filePath: string, rawContent: string): Tier1FileFacts {
  const ext = extname(filePath).toLowerCase();
  const isJsx = ext === '.tsx' || ext === '.jsx';
  const sf = ts.createSourceFile(
    filePath,
    rawContent,
    ts.ScriptTarget.Latest,
    false,
    isJsx ? ts.ScriptKind.TSX : ts.ScriptKind.TS
  );

  let renderBoundary: Tier1FileFacts['renderBoundary'] = 'universal';
  let boundaryDirective: string | undefined;

  for (const stmt of sf.statements) {
    if (ts.isExpressionStatement(stmt) && ts.isStringLiteral(stmt.expression)) {
      const text = stmt.expression.text;
      if (text === 'use client') {
        renderBoundary = 'client';
        boundaryDirective = 'use client';
        break;
      }
      if (text === 'use server') {
        renderBoundary = 'server';
        boundaryDirective = 'use server';
        break;
      }
    } else {
      break;
    }
  }

  const componentUsages: Tier1TemplateComponentUsage[] = [];
  const omissions: ProjectionOmission[] = [];

  if (isJsx) {
    const visit = (node: ts.Node) => {
      if (ts.isJsxOpeningElement(node) || ts.isJsxSelfClosingElement(node)) {
        const tagName = node.tagName.getText(sf);
        if (isCustomJsxTag(tagName)) {
          const props: Tier1TemplateComponentUsage['props'] = [];
          const events: Tier1TemplateComponentUsage['events'] = [];
          let hasDynamicSpread = false;

          for (const attr of node.attributes.properties) {
            if (ts.isJsxSpreadAttribute(attr)) {
              hasDynamicSpread = true;
              omissions.push({
                code: 'DYNAMIC_SPREAD',
                originalStart: attr.getStart(sf),
                originalEnd: attr.getEnd(),
                reason: `JSX spread attribute on <${tagName}>: ${attr.getText(sf)}`,
              });
            } else if (ts.isJsxAttribute(attr)) {
              const attrName = attr.name.getText(sf);
              const start = attr.getStart(sf);
              const end = attr.getEnd();
              if (/^on[A-Z]/.test(attrName)) {
                events.push({ name: attrName, originalStart: start, originalEnd: end });
              } else {
                props.push({
                  name: attrName,
                  isDynamic: Boolean(attr.initializer && ts.isJsxExpression(attr.initializer)),
                  originalStart: start,
                  originalEnd: end,
                });
              }
            }
          }

          componentUsages.push({
            tagName,
            normalizedName: tagName,
            originalStart: node.tagName.getStart(sf),
            originalEnd: node.tagName.getEnd(),
            props,
            events,
            hasDynamicSpread,
          });
        }
      }
      ts.forEachChild(node, visit);
    };
    visit(sf);
  }

  return {
    framework: isJsx ? 'react' : 'ts',
    renderBoundary,
    boundaryDirective,
    componentUsages,
    slots: [],
    omissions,
    sourceFile: sf,
  };
}

export const reactPlugin: FrameworkPlugin = {
  id: 'react',
  extensions: REACT_EXTENSIONS,

  matchesFile(filePath: string): boolean {
    const ext = extname(filePath).toLowerCase();
    return (REACT_EXTENSIONS as readonly string[]).includes(ext);
  },

  projectToVirtualTs(filePath: string, content: string, sourceHash: string): VirtualDocument {
    const ext = extname(filePath).toLowerCase();
    const framework = ext === '.tsx' || ext === '.jsx' ? 'react' : 'ts';
    return createIdentityVirtualDocument(filePath, content, sourceHash, framework);
  },

  extractTier1Facts(doc: VirtualDocument, rawContent: string): Tier1FileFacts {
    return extractReactTier1Facts(doc.originalPath, rawContent);
  },
};
