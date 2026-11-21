import type {
  CodeSearchMatchItem,
  ComponentTreeNodeItem,
  FileInspectionData,
  GraphQueryData,
  QueryEnvelope,
  SourceSliceData,
  WorkspaceMapData,
} from '../../engine/v2';
import { DomainError } from '../../engine/v2';
import type { ToolCallResponse } from '../types';

/**
 * Centralized transport error mapper (backend-standards):
 * Maps typed DomainErrors and unexpected failures into consistent MCP error responses.
 */
export function formatToolError(error: unknown): ToolCallResponse {
  if (error instanceof DomainError) {
    const details = error.details ? ` ${JSON.stringify(error.details)}` : '';
    return {
      isError: true,
      content: [{ type: 'text', text: `[${error.code}] ${error.message}${details}` }],
      structuredContent: {
        error: {
          code: error.code,
          message: error.message,
          ...(error.details ? { details: error.details } : {}),
        },
      },
    };
  }

  const message = error instanceof Error ? error.message : String(error);
  return {
    isError: true,
    content: [{ type: 'text', text: `[INTERNAL_ERROR] ${message}` }],
    structuredContent: {
      error: {
        code: 'INTERNAL_ERROR',
        message,
      },
    },
  };
}

function appendEnvelopeFooter(lines: string[], env: QueryEnvelope<unknown>): void {
  if (env.pagination?.hasMore && env.pagination.nextCursor) {
    lines.push(
      `PAGINATION: showing ${env.pagination.offset + 1}-${env.pagination.offset + Math.min(env.pagination.limit, env.pagination.total - env.pagination.offset)} of ${env.pagination.total} (cursor: "${env.pagination.nextCursor}")`
    );
  }
  if (env.omissions.length > 0) {
    lines.push(`OMISSIONS (${env.omissions.length}, manual check required):`);
    for (const om of env.omissions) {
      const refPart = om.sourceRef ? ` (${om.sourceRef})` : '';
      lines.push(`- [${om.code}] ${om.filePath}:${om.line}:${om.column} — ${om.reason}${refPart}`);
    }
  }
  if (env.diagnostics.length > 0) {
    lines.push(`DIAGNOSTICS (${env.diagnostics.length}):`);
    for (const d of env.diagnostics) {
      lines.push(`- [${d.code}] ${d.message}`);
    }
  }
}

export function buildEnvelopeResponse<T>(
  env: QueryEnvelope<T>,
  format: 'text' | 'json',
  renderText: (env: QueryEnvelope<T>) => string
): ToolCallResponse {
  if (format === 'json') {
    return {
      content: [{ type: 'text', text: JSON.stringify(env, null, 2) }],
      structuredContent: env as unknown as Record<string, unknown>,
    };
  }
  return {
    content: [{ type: 'text', text: renderText(env) }],
    structuredContent: env as unknown as Record<string, unknown>,
  };
}

export function formatWorkspaceMapText(env: QueryEnvelope<WorkspaceMapData>): string {
  const { data } = env;
  const lines: string[] = [
    `WORKSPACE MAP (view=${data.view})`,
    `SCOPE: ${env.scope} | VERIFICATION: tier=${env.verification}`,
  ];

  if (data.totals) {
    lines.push(
      `TOTALS: ${data.totals.packages} package(s), ${data.totals.files} file(s), ${data.totals.symbols} symbol(s), ${data.totals.routes} route(s)`
    );
  }

  if (data.packages?.length) {
    lines.push('PACKAGES:');
    for (const p of data.packages) {
      const namePart = p.name ? ` (${p.name})` : '';
      lines.push(
        `- ${p.packageKey}${namePart} [${p.framework}, router=${p.router}] — ${p.fileCount} files, ${p.symbolCount} symbols, ${p.routeCount} routes`
      );
    }
  }

  if (data.routes?.length) {
    lines.push('ROUTES:');
    for (const r of data.routes) {
      const boundary = r.renderBoundary ? ` [${r.renderBoundary}]` : '';
      lines.push(`- [${r.packageKey}] ${r.urlPath} -> ${r.relPath} (${r.routeType})${boundary}`);
    }
  }

  if (data.files?.length) {
    lines.push('FILES:');
    for (const f of data.files) {
      const flags = [f.isPage ? 'page' : '', f.isLayout ? 'layout' : '', f.renderBoundary ?? '']
        .filter(Boolean)
        .join(',');
      lines.push(`- [${f.packageKey}] ${f.relPath} (${f.framework}${flags ? `, ${flags}` : ''})`);
    }
  }

  if (data.health) {
    lines.push(`UNUSED COMPONENT CANDIDATES (${data.health.unusedComponents.length}):`);
    for (const c of data.health.unusedComponents) {
      lines.push(`- [${c.packageKey}] ${c.name} (${c.relPath}:${c.line}) [confidence=${c.confidence}]`);
    }
  }

  appendEnvelopeFooter(lines, env);
  return lines.join('\n');
}

export function formatFileInspectionText(env: QueryEnvelope<FileInspectionData>): string {
  const { data } = env;
  const lines: string[] = [
    `FILE: ${data.filePath}`,
    `PACKAGE: ${data.packageKey} | FRAMEWORK: ${data.framework} | BOUNDARY: ${data.renderBoundary}${data.boundaryDirective ? ` (${data.boundaryDirective})` : ''} | VERIFICATION: tier=${env.verification}`,
  ];

  if (data.contract) {
    lines.push(`PROPS (${data.contract.props.length}):`);
    for (const p of data.contract.props) {
      lines.push(`- ${p.name}${p.required ? '' : '?'}: ${p.type}`);
    }
    if (data.contract.slots.length > 0) {
      lines.push(`SLOTS: ${data.contract.slots.join(', ')}`);
    }
    if (data.contract.renderedComponents.length > 0) {
      lines.push(`RENDERS: ${data.contract.renderedComponents.join(', ')}`);
    }
  }

  if (data.outline) {
    lines.push(`OUTLINE (${data.outline.length}):`);
    for (const s of data.outline) {
      const exp = s.isExported ? 'export ' : '';
      lines.push(
        `- [${s.kind}] ${exp}${s.name} (L${s.startLine}-${s.endLine}) id=${s.symbolId} (${s.sourceRef})`
      );
    }
  }

  if (data.boundaries) {
    lines.push(`OUTBOUND HTTP (${data.boundaries.outboundHttp.length}):`);
    for (const b of data.boundaries.outboundHttp) {
      const via = b.viaSymbol ? ` via ${b.viaSymbol}` : '';
      lines.push(`- ${b.method} ${b.url} [${b.client}, ${b.source}${via}] @ ${b.filePath}:${b.line}`);
    }
  }

  if (data.imports) {
    lines.push(`IMPORTS (${data.imports.length}):`);
    for (const imp of data.imports) {
      const target = imp.resolvedFilePath ?? '(external/unresolved)';
      lines.push(`- L${imp.line} ${imp.isTypeOnly ? 'type ' : ''}"${imp.specifier}" -> ${target}`);
    }
  }

  appendEnvelopeFooter(lines, env);
  return lines.join('\n');
}

function renderTreeLines(node: ComponentTreeNodeItem, lines: string[], indent = ''): void {
  const pageTag = node.isPage ? ' [page]' : '';
  lines.push(`${indent}- [${node.packageKey}] ${node.componentName} (${node.relPath})${pageTag}`);
  for (const child of node.children) {
    renderTreeLines(child, lines, `${indent}  `);
  }
}

export function formatGraphQueryText(env: QueryEnvelope<GraphQueryData>): string {
  const { data } = env;
  const lines: string[] = [
    `GRAPH QUERY: ${data.query} (${data.targetSummary})`,
    `SCOPE: ${env.scope} | VERIFICATION: tier=${env.verification}`,
  ];

  if (data.summaryByPackage?.length) {
    lines.push('SUMMARY BY PACKAGE:');
    for (const g of data.summaryByPackage) {
      lines.push(`- ${g.packageKey}: ${g.count} hit(s) across ${g.fileCount} file(s)`);
    }
  }

  if (data.tree) {
    lines.push('COMPONENT TREE:');
    renderTreeLines(data.tree, lines);
  }

  if (data.items) {
    lines.push(`RESULTS (${data.items.length}):`);
    for (const item of data.items) {
      const flags = [item.isDefinition ? 'def' : '', item.isWriteAccess ? 'write' : '']
        .filter(Boolean)
        .join(',');
      const tag = flags ? `${item.kind},${flags}` : item.kind;
      lines.push(
        `- [${item.packageKey}] ${item.relPath}:${item.line}:${item.column} [${tag}] ${item.snippet} (${item.sourceRef})`
      );
    }
  }

  appendEnvelopeFooter(lines, env);
  return lines.join('\n');
}

export function formatSourceSliceText(env: QueryEnvelope<SourceSliceData>): string {
  const { data } = env;
  const lines: string[] = [
    `SLICE: ${data.filePath} (L${data.startLine}-${data.endLine} of ${data.totalLines}) (${data.sourceRef})`,
    '```',
    data.content,
    '```',
  ];
  appendEnvelopeFooter(lines, env);
  return lines.join('\n');
}

export function formatCodeSearchText(
  env: QueryEnvelope<{ kind: string; matches: CodeSearchMatchItem[] }>
): string {
  const { data } = env;
  const lines: string[] = [
    `SEARCH (${data.kind}): ${data.matches.length} match(es)`,
    `SCOPE: ${env.scope} | VERIFICATION: tier=${env.verification}`,
  ];
  for (const m of data.matches) {
    const idPart = m.symbolId ? ` id=${m.symbolId}` : '';
    lines.push(
      `- [${m.packageKey}] ${m.relPath}:${m.line}:${m.column} [${m.kind}] ${m.name}: ${m.snippet}${idPart} (${m.sourceRef})`
    );
  }
  appendEnvelopeFooter(lines, env);
  return lines.join('\n');
}
