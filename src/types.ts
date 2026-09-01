export type SfcBlockType =
  | 'template'
  | 'script'
  | 'scriptSetup'
  | 'style'
  | 'custom'
  | 'frontmatter'
  | 'astroTemplate';

export interface Position {
  line: number;
  column: number;
  offset: number;
}

export interface SourceLocation {
  start: Position;
  end: Position;
}

export interface SfcBlock {
  type: SfcBlockType;
  content: string;
  lang: string;
  loc: SourceLocation;
  scoped?: boolean;
  module?: boolean | string;
  attrs?: Record<string, string | true>;
}

export interface SfcDescriptor {
  filename: string;
  rawContent: string;
  template: SfcBlock | null;
  script: SfcBlock | null;
  scriptSetup: SfcBlock | null;
  styles: SfcBlock[];
  customBlocks: SfcBlock[];
}

export interface AstroDescriptor {
  filename: string;
  rawContent: string;
  frontmatter: SfcBlock | null;
  template: SfcBlock | null;
}

export interface RawMatch {
  line: number; // 1-based relative to block
  column: number; // 1-based relative to block
  endLine?: number;
  endColumn?: number;
  text: string;
  clientDirective?: string;
}

export interface ResolvedMatch {
  file: string;
  line: number; // 1-based relative to original file
  column: number; // 1-based relative to original file
  endLine?: number;
  endColumn?: number;
  blockType?: SfcBlockType;
  snippet: string;
  clientDirective?: string;
}

export interface ComponentPropContract {
  name: string;
  type: string;
  required: boolean;
  default?: string;
}

export interface ComponentEmitContract {
  name: string;
  payload?: string;
}

export type RenderBoundaryType =
  | 'server-component'
  | 'client-component'
  | 'server-action'
  | 'isomorphic'
  | 'client-only'
  | 'server-only'
  | 'astro-static'
  | 'astro-island'
  | 'unknown';

export interface RenderBoundaryInfo {
  boundary: RenderBoundaryType;
  directive?: string;
  isClientHydrated: boolean;
}

export interface StateDependencyInfo {
  stores: string[];
  contexts: string[];
  composables: string[];
}

export interface ComponentContract {
  component: string;
  framework: 'vue' | 'react' | 'astro' | 'unknown';
  filePath: string;
  props: ComponentPropContract[];
  emits: ComponentEmitContract[];
  slots: string[];
  exposed?: string[];
  renderBoundary?: RenderBoundaryInfo;
  stateDependencies?: StateDependencyInfo;
}

export interface ContractOptions {
  path: string;
  outputFormat?: 'text' | 'json';
}

export interface ComponentTreeNode {
  component: string;
  filePath: string;
  alias?: string;
  isDynamic?: boolean;
  isAutoImported?: boolean;
  isPage?: boolean;
  depth: number;
  children: ComponentTreeNode[];
}

export interface ComponentTreeResult {
  root: ComponentTreeNode;
  totalComponents: number;
  maxDepthReached: number;
  direction?: 'downward' | 'upward';
}

export interface ComponentTreeOptions {
  entryPath: string;
  maxDepth?: number;
  direction?: 'downward' | 'upward';
  outputFormat?: 'text' | 'json';
  aliasMap?: Record<string, string>;
}

export interface UnusedComponentInfo {
  name: string;
  fileName: string;
  filePath: string;
  framework: 'vue' | 'react' | 'astro' | 'unknown';
}

export interface UnusedComponentsResult {
  targetPath: string;
  totalScanned: number;
  unusedCount: number;
  unusedComponents: UnusedComponentInfo[];
}

export interface UnusedComponentsOptions {
  targetPath: string;
  ignorePatterns?: string[];
  outputFormat?: 'text' | 'json';
}

export type RouteFramework =
  | 'next-app'
  | 'next-pages'
  | 'nuxt'
  | 'astro'
  | 'inertia'
  | 'vue-router'
  | 'unknown';

export type RouteType = 'page' | 'api' | 'layout';

export interface RouteParam {
  name: string;
  type: 'dynamic' | 'catch-all' | 'optional-catch-all';
}

export interface RouteInfo {
  path: string;
  filePath: string;
  type: RouteType;
  framework: RouteFramework;
  params: RouteParam[];
  layouts?: string[];
  handlers?: string[];
}

export interface RouteManifestResult {
  framework: RouteFramework;
  baseDirectory: string;
  totalRoutes: number;
  routes: RouteInfo[];
}

export interface ScanRoutesOptions {
  targetPath: string;
  frameworkHint?: RouteFramework;
  outputFormat?: 'text' | 'json';
}

export interface SyncStats {
  added: number;
  modified: number;
  deleted: number;
  unchanged: number;
  total: number;
  durationMs: number;
}

export interface StateImpactConsumer {
  path: string;
  isPage: boolean;
  renderBoundary?: string;
  kind: 'store' | 'context' | 'composable';
  identifier: string;
}

export interface StateImpactResult {
  identifier: string;
  totalConsumers: number;
  consumers: StateImpactConsumer[];
}

export interface QueryStateImpactOptions {
  identifier: string;
  targetPath?: string;
  outputFormat?: 'text' | 'json';
}

