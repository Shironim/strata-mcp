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
  isUnion?: boolean;
  unionMembers?: string[];
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

export interface ComponentModelContract {
  name: string;
  type?: string;
  required?: boolean;
  default?: string;
}

export interface ComponentSlotDetail {
  name: string;
  isScoped: boolean;
  bindings?: string[];
  payload?: Record<string, string>;
}

export interface ComponentStyleTokens {
  layoutTraps: string[];
  zIndices: string[];
  overflow: string[];
  positioning: string[];
}

export interface InferredPropProperty {
  property: string;
  inferredType?: string;
  usageSnippet?: string;
}

export interface InferredPropDetail {
  propName: string;
  properties: InferredPropProperty[];
}

export interface GlobalSymbolInfo {
  name: string;
  category: 'ziggy-route' | 'auto-import' | 'global-helper' | 'inferred-global';
  hint?: string;
}

export interface ComponentContract {
  component: string;
  framework: 'vue' | 'react' | 'astro' | 'unknown' | 'vue-composable';
  filePath: string;
  props: ComponentPropContract[];
  emits: ComponentEmitContract[];
  slots: string[];
  slotDetails?: ComponentSlotDetail[];
  models?: ComponentModelContract[];
  exposed?: string[];
  variants?: ComponentVariantsInfo;
  renderBoundary?: RenderBoundaryInfo;
  stateDependencies?: StateDependencyInfo;
  dataDependencies?: DataDependencyInfo;
  inferredProps?: InferredPropDetail[];
  globalSymbols?: GlobalSymbolInfo[];
  styleTokens?: ComponentStyleTokens;
  reactivitySmells?: ReactivitySmell[];
  boundaryContracts?: BoundaryContract[];
  formContracts?: FormContract[];
}

export interface ContractOptions {
  path: string;
  inferProps?: boolean;
  resolveGlobals?: boolean;
  outputFormat?: 'text' | 'json';
}

export interface PassedPropInfo {
  propName: string;
  expression: string;
}

export interface ComponentTreeNode {
  component: string;
  filePath: string;
  alias?: string;
  isDynamic?: boolean;
  isAutoImported?: boolean;
  isPage?: boolean;
  isExternalScope?: boolean;
  warning?: string;
  depth: number;
  passedProps?: PassedPropInfo[];
  children: ComponentTreeNode[];
}

export interface PropsDrillingAlert {
  prop: string;
  origin: string;
  drilledThrough: string[];
  target: string;
  depth: number;
  recommendation: string;
}

export interface ComponentTreeResult {
  root: ComponentTreeNode;
  totalComponents: number;
  maxDepthReached: number;
  direction?: 'downward' | 'upward';
  propsDrilling: PropsDrillingAlert[];
  contextGraph?: ContextDependencyGraph;
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
  includeProps?: boolean;
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
  engine: 'in-memory-ast' | 'sqlite-graph-cache' | 'ast-grep' | 'template-similarity-comparator';
  durationMs: number;
  cached?: boolean;
}

export interface UnusedComponentInfo {
  name: string;
  fileName: string;
  filePath: string;
  framework: 'vue' | 'react' | 'astro' | 'unknown' | 'vue-composable';
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
  excludeDirs?: string[];
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
  role?: 'mutator' | 'reader';
  actionsCalled?: string[];
  usageSnippet?: string;
}

export interface StateImpactResult {
  identifier: string;
  totalConsumers: number;
  roleFilter?: 'all' | 'mutators' | 'readers';
  mutatorsCount?: number;
  readersCount?: number;
  mutators?: StateImpactConsumer[];
  readers?: StateImpactConsumer[];
  consumers: StateImpactConsumer[];
  _meta?: EngineMetadata;
}

export interface QueryStateImpactOptions {
  identifier: string;
  targetPath?: string;
  role?: 'all' | 'mutators' | 'readers';
  outputFormat?: 'text' | 'json';
}

export interface TemplateSimilarityCluster {
  similarity: number;
  files: string[];
  sharedStructure: string[];
  recommendation: string;
}

export interface TemplateSimilarityResult {
  workspaceRoot: string;
  clusters: TemplateSimilarityCluster[];
  totalComponentsAudited: number;
  _meta?: EngineMetadata;
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

export type SymbolKind =
  | 'function'
  | 'arrow-function'
  | 'class'
  | 'interface'
  | 'type'
  | 'variable'
  | 'unknown';

export interface SymbolSliceResult {
  symbolName: string;
  kind: SymbolKind;
  filePath: string;
  startLine: number;
  endLine: number;
  code: string;
  signature?: string;
  blastRadius?: {
    totalConsumers: number;
    callers: Array<{ filePath: string; line?: number }>;
    coveringTests?: string[];
    internalCalls?: string[];
  };
  _meta?: EngineMetadata;
}

export interface SliceSymbolOptions {
  path: string;
  symbolName: string;
  workspaceRoot?: string;
  includeBlastRadius?: boolean;
  outputFormat?: 'text' | 'json';
}

export interface EventHandlerInfo {
  event: string;
  handlerName: string;
  line: number;
  status: 'valid' | 'broken' | 'inline-expression';
  source?: 'local-function' | 'composable-return' | 'prop' | 'import' | 'unresolved';
}

export interface DeadHandlerInfo {
  name: string;
  line: number;
  kind: 'function' | 'const';
  hint: string;
}

export interface EventHandlerAuditResult {
  filePath: string;
  totalEventBindings: number;
  validHandlers: EventHandlerInfo[];
  brokenHandlers: EventHandlerInfo[];
  inlineExpressions: EventHandlerInfo[];
  deadScriptHandlers: DeadHandlerInfo[];
  _meta?: EngineMetadata;
}

export interface AuditEventHandlersOptions {
  path: string;
  code?: string;
  outputFormat?: 'text' | 'json';
}

export interface StateChainNode {
  identifier: string;
  filePath: string;
  kind: 'store' | 'composable' | 'component' | 'helper';
  direction: 'consumer' | 'dependency';
  depth: number;
}

export interface StateChainResult {
  identifier: string;
  entryFile?: string;
  consumers: StateChainNode[];
  dependencies: StateChainNode[];
  _meta?: EngineMetadata;
}

export interface TraceStateChainOptions {
  identifier: string;
  targetPath?: string;
  direction?: 'consumers' | 'dependencies' | 'both';
  maxDepth?: number;
  outputFormat?: 'text' | 'json';
}

export interface ReactivitySmell {
  type: 'vue-props-destructure' | 'vue-prop-mutation' | 'react-inline-in-loop' | 'general';
  severity: 'error' | 'warning';
  message: string;
  line: number;
  snippet?: string;
  recommendation: string;
}

export interface ArbitraryTokenViolation {
  file: string;
  line: number;
  token: string;
  category: 'color' | 'spacing' | 'radius' | 'size' | 'other';
  recommendation: string;
}

export interface A11yViolation {
  file: string;
  line: number;
  element: string;
  issue: string;
  recommendation: string;
}

export interface DesignSystemAuditResult {
  workspaceRoot: string;
  totalFilesAudited: number;
  arbitraryTokens: ArbitraryTokenViolation[];
  radiusDistribution: Record<string, number>;
  a11yViolations: A11yViolation[];
  _meta?: EngineMetadata;
}

export interface AuditDesignTokensOptions {
  targetPath: string;
  scopePath?: string;
  excludeDirs?: string[];
  outputFormat?: 'text' | 'json';
}

// ---------------------------------------------------------------------------
// Universal Data Fetching & Boundary Contract (Vue, Nuxt, React, Next, Astro, Inertia)
// ---------------------------------------------------------------------------

export type BoundaryContractType =
  | 'inertia-form'
  | 'inertia-router'
  | 'tanstack-query'
  | 'swr'
  | 'nuxt-fetch'
  | 'server-action'
  | 'native-fetch'
  | 'axios';

export type BoundaryMethod = 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE' | 'UNKNOWN';

export interface BoundaryContract {
  boundaryType: BoundaryContractType;
  method: BoundaryMethod;
  targetEndpoint: string;
  endpointSource: 'literal' | 'ziggy-route' | 'template-literal' | 'action-symbol' | 'variable';
  payloadKeys?: string[];
  optimisticUpdate?: boolean;
  loc?: { line: number; column?: number };
}

// ---------------------------------------------------------------------------
// Universal Form & Payload Contract
// ---------------------------------------------------------------------------

export interface FormFieldContract {
  key: string;
  type: string; // 'text' | 'email' | 'number' | 'file' | 'password' | 'checkbox' | 'select' | 'textarea' | 'unknown'
  required: boolean;
  binding?: string; // e.g. "form.name", "name", "v-model"
}

export interface FormContract {
  binding?: string;
  isMultipart: boolean;
  fields: FormFieldContract[];
  submitEndpoint?: string;
}

// ---------------------------------------------------------------------------
// Universal Implicit Context Graph (Provide/Inject & React Context)
// ---------------------------------------------------------------------------

export interface ContextDependencyNode {
  key: string;
  type: 'vue-provide' | 'vue-inject' | 'react-provider' | 'react-use-context';
  component: string;
  filePath: string;
  line: number;
  valueSnippet?: string;
}

export interface ContextDependencyRelation {
  key: string;
  provider?: ContextDependencyNode;
  consumer: ContextDependencyNode;
  isCoveredInTree: boolean;
  warning?: string;
}

export interface ContextDependencyGraph {
  providers: ContextDependencyNode[];
  consumers: ContextDependencyNode[];
  relations: ContextDependencyRelation[];
  danglingConsumers: ContextDependencyRelation[];
}

// ---------------------------------------------------------------------------
// Zero-Bloat Bundle & Island Architecture Awareness
// ---------------------------------------------------------------------------

export interface BundleWeightWarning {
  file: string;
  line: number;
  module: string;
  category: 'chart' | 'rich-text' | 'pdf' | 'spreadsheet' | '3d-canvas' | 'heavy-utility';
  recommendation: string;
  islandDirective?: string; // e.g. 'client:load' vs 'client:visible'
}

export interface BundleAuditResult {
  workspaceRoot: string;
  totalFilesAudited: number;
  heavyEagerImports: BundleWeightWarning[];
  totalWarnings: number;
  _meta?: EngineMetadata;
}



