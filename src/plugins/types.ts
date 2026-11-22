import type ts from 'typescript';

export type FrontendFrameworkId =
  | 'vue'
  | 'nuxt'
  | 'react'
  | 'next'
  | 'svelte'
  | 'astro'
  | 'ts';

export type VirtualSegmentKind =
  | 'script'
  | 'script-setup'
  | 'template-tag'
  | 'template-prop'
  | 'template-event'
  | 'template-model'
  | 'template-slot'
  | 'template-expr';

export interface VirtualSegment {
  originalStart: number;
  originalEnd: number;
  virtualStart: number;
  virtualEnd: number;
  kind: VirtualSegmentKind;
}

export interface ProjectionOmission {
  code: 'DYNAMIC_SPREAD' | 'UNPROJECTED_EXPRESSION' | 'PARSE_DIAGNOSTIC';
  originalStart: number;
  originalEnd: number;
  reason: string;
}

export interface OriginalSpan {
  start: number;
  end: number;
  kind: VirtualSegmentKind;
}

export interface VirtualDocument {
  readonly originalPath: string;
  readonly virtualPath: string;
  readonly framework: FrontendFrameworkId;
  readonly isIdentity: boolean;
  readonly virtualCode: string;
  readonly sourceHash: string;
  readonly segments: readonly VirtualSegment[];
  readonly omissions: readonly ProjectionOmission[];

  /** Maps a character offset in the original file to its offset in virtualCode, or null if unmapped. */
  toVirtualOffset(originalOffset: number): number | null;

  /** Maps a span in virtualCode back to the original file offset span, or null if synthetic. */
  toOriginalSpan(virtualStart: number, virtualEnd?: number): OriginalSpan | null;
}

export interface Tier1TemplateComponentUsage {
  tagName: string;
  normalizedName: string;
  originalStart: number;
  originalEnd: number;
  props: Array<{
    name: string;
    isDynamic: boolean;
    originalStart: number;
    originalEnd: number;
  }>;
  events: Array<{
    name: string;
    originalStart: number;
    originalEnd: number;
  }>;
  hasDynamicSpread: boolean;
}

export interface Tier1FileFacts {
  framework: FrontendFrameworkId;
  renderBoundary?: 'client' | 'server' | 'island' | 'universal' | 'unknown';
  boundaryDirective?: string;
  componentUsages: Tier1TemplateComponentUsage[];
  slots: string[];
  omissions: ProjectionOmission[];
  /** Optional pre-parsed TypeScript AST when doc.isIdentity is true, to avoid duplicate parsing. */
  sourceFile?: ts.SourceFile;
}

export interface EnrichedPropInfo {
  name: string;
  type: string;
  required: boolean;
  defaultValue?: string;
}

export interface EnrichedComponentContract {
  props: EnrichedPropInfo[];
  emits: Array<{ name: string; payloadType?: string }>;
  slots: string[];
  models: string[];
}

export interface RouteEntry {
  urlPath: string;
  filePath: string;
  routeType: 'page' | 'api' | 'layout' | 'error' | 'loading';
  params: string[];
  handlers?: string[];
  layoutChain?: string[];
}

export interface FrameworkPlugin {
  readonly id: FrontendFrameworkId;
  readonly extensions: readonly string[];

  /** Returns true when this plugin owns the given file path. */
  matchesFile(filePath: string): boolean;

  /** Projects an SFC or script file into a Virtual TSX document with bidirectional offset mapping. */
  projectToVirtualTs(filePath: string, content: string, sourceHash: string): VirtualDocument;

  /** Extracts syntax-level framework facts without requiring the TypeScript TypeChecker. */
  extractTier1Facts(doc: VirtualDocument, rawContent: string): Tier1FileFacts;

  /** Optional TypeScript TypeChecker enrichment for component contracts. */
  enrichContractWithTypes?(
    doc: VirtualDocument,
    checker: ts.TypeChecker,
    sourceFile: ts.SourceFile,
    baseFacts: Tier1FileFacts
  ): EnrichedComponentContract;

  /** Optional framework-specific route scanner for a single monorepo package. */
  scanPackageRoutes?(packageRoot: string, files: string[]): Promise<RouteEntry[]>;

  /** Optional resolver for framework virtual modules (e.g. #imports, #components, $lib). */
  resolveSpecialModule?(
    specifier: string,
    containingFile: string,
    packageRoot: string
  ): string | null;
}
