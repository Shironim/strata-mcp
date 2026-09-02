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

export type BoundaryViolationSeverity = 'warning' | 'error';

export interface BoundaryViolation {
  code: string;
  severity: BoundaryViolationSeverity;
  message: string;
  hint?: string;
}

export interface RenderBoundaryInfo {
  boundary: RenderBoundaryType;
  directive?: string;
  isClientHydrated: boolean;
  violations?: BoundaryViolation[];
}

export interface ComponentVariantsInfo {
  variants: Record<string, string[]>;
  defaultVariants?: Record<string, string>;
}

export interface StateDependencyInfo {
  stores: string[];
  contexts: string[];
  composables: string[];
}

export interface DataDependencyInfo {
  serverActions?: string[];
  queryKeys?: string[];
  endpoints?: string[];
  mutations?: string[];
}

export interface ComponentContract {
  component: string;
  framework: 'vue' | 'react' | 'astro' | 'unknown';
  filePath: string;
  props: ComponentPropContract[];
  emits: ComponentEmitContract[];
  slots: string[];
  exposed?: string[];
  variants?: ComponentVariantsInfo;
  renderBoundary?: RenderBoundaryInfo;
  stateDependencies?: StateDependencyInfo;
  dataDependencies?: DataDependencyInfo;
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
  isExternalScope?: boolean;
  depth: number;
  children: ComponentTreeNode[];
}

export interface ComponentTreeResult {
  root: ComponentTreeNode;
  totalComponents: number;
  maxDepthReached: number;
  direction?: 'downward' | 'upward';
  resolvedRoute?: {
    routePath: string;
    matchedRoute: string;
    filePath: string;
    framework: RouteFramework;
    layouts?: string[];
  };
}

export interface ComponentTreeOptions {
  entryPath?: string;
  routePath?: string;
  targetPath?: string;
  scopeFilter?: string | string[];
  maxDepth?: number;
  direction?: 'downward' | 'upward';
  outputFormat?: 'text' | 'json';
  aliasMap?: Record<string, string>;
  includeLayouts?: boolean;
}

export interface ResolveRouteEntryOptions {
  targetPath: string;
  routePath: string;
  frameworkHint?: RouteFramework;
}

export interface ResolveRouteEntryResult {
  matched: boolean;
  routePath: string;
  matchedPattern?: string;
  filePath?: string;
  framework?: RouteFramework;
  layouts?: string[];
  params?: Record<string, string>;
  availableRoutes?: string[];
}

export interface EngineMetadata {
  engine: 'in-memory-ast' | 'sqlite-graph-cache' | 'ast-grep';
  durationMs: number;
  cached?: boolean;
}

export interface UnusedComponentInfo {
  name: string;
  fileName: string;
  filePath: string;
  framework: 'vue' | 'react' | 'astro' | 'unknown';
  isPage?: boolean;
}

export interface UnusedComponentsResult {
  targetPath: string;
  totalScanned: number;
  unusedCount: number;
  unusedComponents: UnusedComponentInfo[];
  orphanComponents?: UnusedComponentInfo[];
  unreferencedPages?: UnusedComponentInfo[];
  _meta?: EngineMetadata;
}

export interface UnusedComponentsOptions {
  targetPath: string;
  ignorePatterns?: string[];
  excludePages?: boolean;
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

export interface RouteModuleSummary {
  prefix: string;
  count: number;
}

export interface RouteManifestResult {
  framework: RouteFramework;
  baseDirectory: string;
  totalRoutes: number;
  routes: RouteInfo[];
  viewMode?: 'summary' | 'full' | 'tree';
  summaries?: Record<string, number>;
  _meta?: EngineMetadata;
}

export interface ScanRoutesOptions {
  targetPath: string;
  frameworkHint?: RouteFramework;
  prefix?: string;
  view?: 'summary' | 'full' | 'tree';
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
  _meta?: EngineMetadata;
}

export interface QueryStateImpactOptions {
  identifier: string;
  targetPath?: string;
  outputFormat?: 'text' | 'json';
}

export interface UnusedStateItem {
  identifier: string;
  kind: 'store' | 'context' | 'composable';
  filePath: string;
}

export interface UnusedStateResult {
  workspaceRoot: string;
  totalScanned: number;
  unusedCount: number;
  unusedState: UnusedStateItem[];
  _meta?: EngineMetadata;
}

export interface UnusedStateOptions {
  targetPath?: string;
  outputFormat?: 'text' | 'json';
}


