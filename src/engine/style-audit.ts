import { promises as fs } from 'node:fs';
import { extname, relative, resolve } from 'node:path';
import { collectFiles } from './collector';
import type {
  A11yViolation,
  ArbitraryTokenViolation,
  AuditDesignTokensOptions,
  DesignSystemAuditResult,
} from '../types';

const COMPONENT_EXTENSIONS = new Set(['.vue', '.tsx', '.jsx', '.astro', '.html']);

const ARBITRARY_COLOR_REGEX =
  /(?:^|\s)(?:[a-z0-9_-]+:)?(?:text|bg|border|ring|fill|stroke|from|to|via)-\[(#[0-9a-fA-F]{3,8}|rgba?\([^\]]+\))\]/g;
const ARBITRARY_SPACING_REGEX =
  /(?:^|\s)(?:[a-z0-9_-]+:)?(?:p|px|py|pt|pb|pl|pr|m|mx|my|mt|mb|ml|mr|gap|gap-x|gap-y)-\[([0-9]+(?:px|rem|em|%))\]/g;
const ARBITRARY_SIZE_REGEX =
  /(?:^|\s)(?:[a-z0-9_-]+:)?(?:w|h|min-w|max-w|min-h|max-h|top|bottom|left|right)-\[([0-9]+(?:px|rem|em|%))\]/g;
const ARBITRARY_RADIUS_REGEX =
  /(?:^|\s)(?:[a-z0-9_-]+:)?rounded-\[([^\]]+)\]/g;

const STANDARD_RADIUS_REGEX =
  /\brounded(?:-(?:none|sm|md|lg|xl|2xl|3xl|full))?\b/g;

const CLASS_ATTR_REGEX = /(?:class|className|:class)=["'`]([^"'`]+)["'`]/g;

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
  const allFiles = await collectFiles(rootDir);

  const arbitraryTokens: ArbitraryTokenViolation[] = [];
  const radiusDistribution: Record<string, number> = {};
  const a11yViolations: A11yViolation[] = [];
  let totalFilesAudited = 0;

  for (const file of allFiles) {
    const ext = extname(file).toLowerCase();
    if (!COMPONENT_EXTENSIONS.has(ext)) continue;

    if (options.scopePath && !file.includes(options.scopePath)) {
      continue;
    }

    let content = '';
    try {
      content = await fs.readFile(file, 'utf8');
    } catch {
      continue;
    }

    totalFilesAudited++;
    const relFile = relative(rootDir, file).replace(/\\/g, '/');
    const lines = content.split(/\r?\n/);

    // 1. Line-by-line Class Token Analysis
    for (let i = 0; i < lines.length; i++) {
      const lineNum = i + 1;
      const line = lines[i];

      // Extract class string matches
      for (const classMatch of line.matchAll(CLASS_ATTR_REGEX)) {
        const classStr = classMatch[1];
        const tokens = classStr.split(/\s+/).filter(Boolean);

        for (const token of tokens) {
          // Arbitrary Color
          if (/(?:text|bg|border|ring|fill|stroke|from|to|via)-\[(#[0-9a-fA-F]+|rgba?\([^\]]+\))\]/.test(token)) {
            arbitraryTokens.push({
              file: relFile,
              line: lineNum,
              token,
              category: 'color',
              recommendation: `Replace arbitrary color '${token}' with a semantic design token (e.g. text-foreground, bg-muted, border-border).`,
            });
          }

          // Arbitrary Spacing
          if (/(?:^|\s)(?:[a-z0-9_-]+:)?(?:p|px|py|pt|pb|pl|pr|m|mx|my|mt|mb|ml|mr|gap|gap-x|gap-y)-\[[0-9]+(?:px|rem|em|%)\]/.test(token)) {
            arbitraryTokens.push({
              file: relFile,
              line: lineNum,
              token,
              category: 'spacing',
              recommendation: `Replace arbitrary spacing '${token}' with Tailwind scale token (e.g. p-3, m-4, gap-2).`,
            });
          }

          // Arbitrary Size
          if (/(?:^|\s)(?:[a-z0-9_-]+:)?(?:w|h|min-w|max-w|min-h|max-h|top|bottom|left|right)-\[[0-9]+(?:px|rem|em|%)\]/.test(token)) {
            arbitraryTokens.push({
              file: relFile,
              line: lineNum,
              token,
              category: 'size',
              recommendation: `Replace arbitrary dimension '${token}' with Tailwind sizing class or CSS variable.`,
            });
          }

          // Arbitrary Radius
          if (/(?:^|\s)(?:[a-z0-9_-]+:)?rounded-\[[^\]]+\]/.test(token)) {
            arbitraryTokens.push({
              file: relFile,
              line: lineNum,
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
      }
    }

    // 2. a11y AST Checks (Buttons, Inputs, Images)
    for (let i = 0; i < lines.length; i++) {
      const lineNum = i + 1;
      const line = lines[i];

      // a11y Check A: Missing alt attribute on images
      const imgMatch = line.match(/<(?:img|NuxtImg|Image)\b([^>]*)\/?>/i);
      if (imgMatch) {
        const attrs = imgMatch[1];
        if (!/\balt\s*=/i.test(attrs) && !/:alt\s*=/i.test(attrs)) {
          a11yViolations.push({
            file: relFile,
            line: lineNum,
            element: imgMatch[0].slice(0, 40),
            issue: 'Image is missing an alt attribute.',
            recommendation: 'Add alt="..." describing the visual content or alt="" if purely decorative.',
          });
        }
      }

      // a11y Check B: Missing label/aria on form input
      const inputMatch = line.match(/<(?:input|Input)\b([^>]*)\/?>/i);
      if (inputMatch) {
        const attrs = inputMatch[1];
        const isHiddenOrButton = /type=["'](hidden|submit|button|reset)["']/i.test(attrs);
        if (!isHiddenOrButton) {
          const hasAria = /aria-label\s*=|aria-labelledby\s*=/i.test(attrs);
          const hasId = /\bid\s*=/i.test(attrs);
          if (!hasAria && !hasId) {
            a11yViolations.push({
              file: relFile,
              line: lineNum,
              element: inputMatch[0].slice(0, 40),
              issue: 'Form input missing aria-label, aria-labelledby, or id attribute for <label for="..."> pairing.',
              recommendation: 'Add aria-label="..." or connect with a corresponding <label for="..."> tag.',
            });
          }
        }
      }

      // a11y Check C: Icon-only button without aria-label
      const buttonMatch = line.match(/<(?:button|Button)\b([^>]*)>([\s\S]*?)<\/(?:button|Button)>/i);
      if (buttonMatch) {
        const attrs = buttonMatch[1];
        const inner = buttonMatch[2].trim();
        const hasAria = /aria-label\s*=|aria-labelledby\s*=/i.test(attrs);

        // If inner content only has icons/svgs and no textual character
        const isOnlyIcon =
          (/<(?:svg|[A-Za-z0-9_]*Icon|[A-Za-z0-9_]*icon|i\b)[^>]*>/i.test(inner) &&
            !inner.replace(/<[^>]+>/g, '').trim()) ||
          inner === '';

        if (!hasAria && isOnlyIcon) {
          a11yViolations.push({
            file: relFile,
            line: lineNum,
            element: '<button> (icon-only)',
            issue: 'Interactive button contains only icon/svg without accessible label.',
            recommendation: 'Add aria-label="..." to the button or include an inner <span class="sr-only">Label</span>.',
          });
        }
      }
    }
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
      lines.push(`  ⚠️  ${a11y.file}:${a11y.line} — ${a11y.element}`);
      lines.push(`     Issue: ${a11y.issue}`);
      lines.push(`     Fix: ${a11y.recommendation}`);
    }
    if (result.a11yViolations.length > 30) {
      lines.push(`  ... and ${result.a11yViolations.length - 30} more a11y violations.`);
    }
  }

  return lines.join('\n');
}
