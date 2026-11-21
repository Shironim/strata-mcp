import { extname } from 'node:path';
import { parseAstro } from '../engine/astro-sfc';
import { astroExpressionEnd } from '../engine/astro-template';
import { VirtualDocumentBuilder } from './virtual-doc';
import type {
  FrameworkPlugin,
  ProjectionOmission,
  Tier1FileFacts,
  Tier1TemplateComponentUsage,
  VirtualDocument,
} from './types';

interface AstroScanResult {
  componentUsages: Tier1TemplateComponentUsage[];
  slots: string[];
  omissions: ProjectionOmission[];
  hasClientIsland: boolean;
  clientDirective?: string;
}

function projectAstroFile(
  filePath: string,
  content: string,
  sourceHash: string
): { doc: VirtualDocument; scan: AstroScanResult } {
  const builder = new VirtualDocumentBuilder(filePath, content, sourceHash, 'astro');
  const componentUsages: Tier1TemplateComponentUsage[] = [];
  const slots = new Set<string>();
  const omissions: ProjectionOmission[] = [];
  let hasClientIsland = false;
  let clientDirective: string | undefined;

  const descriptor = parseAstro(content, filePath);

  if (descriptor.frontmatter) {
    builder
      .appendMapped(
        descriptor.frontmatter.loc.start.offset,
        descriptor.frontmatter.loc.end.offset,
        'script-setup'
      )
      .appendSynthetic('\n');
  }

  for (const scriptBlock of descriptor.scripts ?? []) {
    builder
      .appendMapped(scriptBlock.loc.start.offset, scriptBlock.loc.end.offset, 'script')
      .appendSynthetic('\n');
  }

  if (descriptor.template) {
    const tplBase = descriptor.template.loc.start.offset;
    const tpl = descriptor.template.content;

    builder.appendSynthetic('\nfunction __strata_template__() {\n');

    // Scan <slot ...> declarations
    const slotRegex = /<slot(?:\s+[^>]*name\s*=\s*["']([^"']+)["'])?[^>]*>/gi;
    let slotMatch: RegExpExecArray | null;
    while ((slotMatch = slotRegex.exec(tpl)) !== null) {
      slots.add(slotMatch[1] || 'default');
    }

    // Scan custom PascalCase component tags in Astro template
    const tagRegex = /<([A-Z][A-Za-z0-9_.]*)\b/g;
    let match: RegExpExecArray | null;
    while ((match = tagRegex.exec(tpl)) !== null) {
      const tagName = match[1];
      const tagStart = tplBase + match.index + 1;
      const tagEnd = tagStart + tagName.length;

      // Scan attributes until closing '>' respecting quoted strings and nested { ... }
      let i = match.index + match[0].length;
      const props: Tier1TemplateComponentUsage['props'] = [];
      let hasDynamicSpread = false;

      builder.appendSynthetic('  void (<').appendMapped(tagStart, tagEnd, 'template-tag');

      while (i < tpl.length) {
        while (i < tpl.length && /\s/.test(tpl[i])) i++;
        if (i >= tpl.length || tpl[i] === '>' || (tpl[i] === '/' && tpl[i + 1] === '>')) {
          break;
        }

        if (tpl[i] === '{') {
          const exprEnd = astroExpressionEnd(tpl, i);
          const inner = tpl.slice(i + 1, exprEnd - 1).trim();
          if (inner.startsWith('...')) {
            hasDynamicSpread = true;
            const om: ProjectionOmission = {
              code: 'DYNAMIC_SPREAD',
              originalStart: tplBase + i,
              originalEnd: tplBase + exprEnd,
              reason: `Astro spread attribute on <${tagName}>`,
            };
            omissions.push(om);
            builder.addOmission(om);
            builder.appendSynthetic(' ').appendMapped(tplBase + i, tplBase + exprEnd, 'template-expr');
          }
          i = exprEnd;
          continue;
        }

        const keyStart = i;
        while (i < tpl.length && /[A-Za-z0-9_:@.-]/.test(tpl[i])) i++;
        const key = tpl.slice(keyStart, i);
        if (!key) {
          i++;
          continue;
        }

        if (key.startsWith('client:')) {
          hasClientIsland = true;
          clientDirective ??= key;
        }

        while (i < tpl.length && /\s/.test(tpl[i])) i++;
        let attrEnd = i;
        let isDynamic = false;

        if (tpl[i] === '=') {
          i++;
          while (i < tpl.length && /\s/.test(tpl[i])) i++;
          if (tpl[i] === '"' || tpl[i] === "'") {
            const quote = tpl[i++];
            const valStart = i;
            while (i < tpl.length && tpl[i] !== quote) {
              if (tpl[i] === '\\') i += 2;
              else i++;
            }
            const valStr = tpl.slice(valStart, i);
            if (i < tpl.length) i++;
            attrEnd = i;
            if (/^[A-Za-z_$][A-Za-z0-9_$]*$/.test(key)) {
              builder
                .appendSynthetic(' ')
                .appendMapped(tplBase + keyStart, tplBase + keyStart + key.length, 'template-prop')
                .appendSynthetic(`=${JSON.stringify(valStr)}`);
            }
          } else if (tpl[i] === '{') {
            isDynamic = true;
            const exprStart = i + 1;
            const exprEnd = astroExpressionEnd(tpl, i);
            attrEnd = exprEnd;
            if (/^[A-Za-z_$][A-Za-z0-9_$]*$/.test(key)) {
              builder
                .appendSynthetic(' ')
                .appendMapped(tplBase + keyStart, tplBase + keyStart + key.length, 'template-prop')
                .appendSynthetic('={')
                .appendMapped(tplBase + exprStart, tplBase + exprEnd - 1, 'template-expr')
                .appendSynthetic('}');
            }
            i = exprEnd;
          }
        } else if (/^[A-Za-z_$][A-Za-z0-9_$]*$/.test(key)) {
          builder
            .appendSynthetic(' ')
            .appendMapped(tplBase + keyStart, tplBase + keyStart + key.length, 'template-prop');
        }

        if (!key.startsWith('client:')) {
          props.push({
            name: key,
            isDynamic,
            originalStart: tplBase + keyStart,
            originalEnd: tplBase + attrEnd,
          });
        }
      }

      builder.appendSynthetic(' />);\n');

      componentUsages.push({
        tagName,
        normalizedName: tagName,
        originalStart: tagStart,
        originalEnd: tagEnd,
        props,
        events: [],
        hasDynamicSpread,
      });
    }

    builder.appendSynthetic('}\nvoid __strata_template__;\n');
  }

  return {
    doc: builder.build(),
    scan: {
      componentUsages,
      slots: [...slots],
      omissions,
      hasClientIsland,
      clientDirective,
    },
  };
}

export const astroPlugin: FrameworkPlugin = {
  id: 'astro',
  extensions: ['.astro'] as const,

  matchesFile(filePath: string): boolean {
    return extname(filePath).toLowerCase() === '.astro';
  },

  projectToVirtualTs(filePath: string, content: string, sourceHash: string): VirtualDocument {
    return projectAstroFile(filePath, content, sourceHash).doc;
  },

  extractTier1Facts(doc: VirtualDocument, rawContent: string): Tier1FileFacts {
    const { scan } = projectAstroFile(doc.originalPath, rawContent, doc.sourceHash);
    return {
      framework: 'astro',
      renderBoundary: scan.hasClientIsland ? 'island' : 'server',
      boundaryDirective: scan.clientDirective,
      componentUsages: scan.componentUsages,
      slots: scan.slots,
      omissions: scan.omissions,
    };
  },
};
