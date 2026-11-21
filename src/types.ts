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

export type SourcePosition = Position;

export interface SourceLocation {
  start: Position;
  end: Position;
}

export type SourceSpan = SourceLocation;

export interface SourceSnapshot {
  file: string;
  sha256: string;
  encoding: 'utf-8';
  offsetUnit: 'utf16';
  lineCount: number;
}

export interface SourceRef {
  sha256: string;
  startOffset: number;
  endOffset: number;
}

/** Source retrieval evidence; completeness is relative to the declared selection policy. */
export interface RetrievalEvidence {
  version: 1;
  workspace: string | null;
  scope: string | null;
  queryId: string;
  retrievalId: string;
  inputIdentity?: { kind: 'inline'; hash: string; algorithm: 'sha256-canonical-json' };
  policy: string;
  engineRevision: string;
  index: null | { generation: string; configFingerprint: string; analysisFingerprint?: string; cacheVersion: string; manifestHash: string; consistency: 'observed-stable' | 'changed' | 'unavailable' };
  config: { applicability: 'not-used' | 'unverified' | 'indexed'; reason: string; fingerprint?: string };
  source?: SourceSnapshot;
  freshness: 'current' | 'stale' | 'unavailable';
  freshnessBoundary: 'source-rechecked-after-selection' | 'index-rechecked-after-analysis' | 'not-verified';
  completeness: 'complete' | 'partial';
  basis: 'source' | 'derived';
  sourceFreshness?: 'current' | 'stale' | 'unavailable';
  dependencies?: { status: 'unverified' | 'current' | 'stale'; reason: string; count?: number };
  selectionReason: string;
  omissions: Array<{ code: string; reason: string }>;
  limitations: string[];
  budget?: {
    maxBytes?: number;
    estimatedBytes: number;
    isTruncated: boolean;
    continuationToken?: string;
    /** Output selection equality only; not proof of a complete input snapshot. */
    consistency?: 'selection-bound';
  };
}

export interface ContinuationTokenPayload {
  version: 1;
  tool: string;
  queryId: string;
  sourceHash?: string;
  indexGeneration?: string | null;
  configFingerprint?: string | null;
  /** Hash of the entire selected collection, not a workspace input snapshot. */
  selectionHash?: string;
  engineRevision: string;
  offset: number;
  totalItems: number;
  issuedAt: number;
}

export interface SourceLineRange {
  startLine: number;
  endLine: number;
}

export type EvidenceBasis = 'source' | 'derived' | 'heuristic';
export type EvidenceResolution = 'resolved' | 'candidate' | 'unresolved' | 'unsupported';

export interface Evidence {
  basis: EvidenceBasis;
  resolution: EvidenceResolution;
  method: string;
  reason?: string;
  refs?: SourceRef[];
}

export interface SourceRegion {
  kind: string;
  name?: string;
  attributes?: Record<string, string | boolean>;
  span: SourceSpan;
  lineRange: SourceLineRange | null;
  ref: SourceRef;
  evidence: Evidence;
  children?: SourceRegion[];
}

export interface SourceMapDiagnostic {
  code: string;
  message: string;
  span?: SourceSpan;
}

export type FrontendFramework =
  | 'vue'
  | 'nuxt'
  | 'react'
  | 'next'
  | 'astro'
  | 'svelte'
  | 'solid'
  | 'unknown';

export type DocumentType =
  | 'vue-sfc'
  | 'astro-sfc'
  | 'svelte-sfc'
  | 'jsx-module'
  | 'script-module'
  | 'vue'
  | 'astro'
  | 'script';

export interface SourceMapResult {
  snapshot: SourceSnapshot;
  documentType: DocumentType;
  framework: FrontendFramework | string;
  status: 'complete' | 'partial';
  regions: SourceRegion[];
  diagnostics: SourceMapDiagnostic[];
  supported: string[];
  unsupported: string[];
  coverage?: { totalRegions: number; returnedRegions: number; truncated: boolean; childRegionsTruncated: boolean };
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
  diagnostics?: Array<{ code: string; message: string }>;
}

export interface AstroIslandContract {
  component: string;
  directive: string;
  directiveValue?: string;
  props?: Record<string, string>;
  loc?: SourceLocation;
}

export interface AstroDescriptor {
  filename: string;
  rawContent: string;
  frontmatter: SfcBlock | null;
  template: SfcBlock | null;
  scripts?: SfcBlock[];
  styles?: SfcBlock[];
  diagnostics?: Array<{ code: string; message: string }>;
}

export interface SvelteDescriptor {
  filename: string;
  rawContent: string;
  instance: SfcBlock | null;
  module: SfcBlock | null;
  template: SfcBlock | null;
  styles?: SfcBlock[];
  legacySlots?: ComponentSlotDetail[];
  diagnostics?: Array<{ code: string; message: string }>;
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
  usageKind?: 'import' | 'export' | 'render';
  snippet: string;
  clientDirective?: string;
}

export interface InputDependency {
  path: string;
  hash: string;
  isExternal: boolean;
}

export interface ProjectOwnershipInfo {
  scopeRoot: string | null;
  ownerRoot: string | null;
  status: 'owned' | 'unverified' | 'conflict' | 'outside-scope';
  applicationFramework: 'next' | 'nuxt' | 'astro' | 'svelte' | null;
  appRoot: string | null;
  configFiles: string[];
  dependencies: InputDependency[];
  diagnostics: Array<{ code: string; reason: string }>;
}

export interface ComponentPropContract {
  name: string;
  type: string;
  required: boolean;
  default?: string;
  isUnion?: boolean;
  unionMembers?: string[];
  description?: string;
  deprecated?: boolean | string;
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
  evidence?: Evidence;
}

export interface ComponentVariantsInfo {
  variants: Record<string, string[]>;
  defaultVariants?: Record<string, string>;
}

export type StateAccessMode = 'read' | 'write' | 'watch';

export interface StateDependencyItem {
  kind: 'store' | 'context' | 'composable';
  identifier: string;
  accessMode: StateAccessMode;
  lineNumber?: number;
  usageSnippet?: string;
  evidence?: Evidence;
  accessedProperties?: string[];
}

export interface StateDependencyInfo {
  stores: string[];
  contexts: string[];
  composables: string[];
  items?: StateDependencyItem[];
  diagnostics?: Array<{ code: string; reason: string }>;
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
  description?: string;
  bindings?: string[];
  payload?: Record<string, string>;
}

export interface DynamicClassBinding {
  line: number;
  tag: string;
  directive: ':class' | 'className';
  condition: string;
  tokens: string[];
}

export interface VisibilityDirective {
  line: number;
  tag: string;
  directive: 'v-show' | 'v-if' | 'v-else-if' | 'v-else';
  expression: string;
}

export interface RootWrapperLayout {
  tag: string;
  layoutTokens: string[];
  rawClass?: string;
  line?: number;
}

export interface ComponentLayoutStructure {
  rootWrapper?: RootWrapperLayout;
  dynamicBindings: DynamicClassBinding[];
  visibilityDirectives: VisibilityDirective[];
}

export interface UnresolvedMetadataField {
  field: string;
  expression: string;
  reason: string;
}

export interface NuxtPageMetaContract {
  layout?: string | false;
  middleware?: string[];
  alias?: string[];
  keepalive?: boolean;
  pageTransition?: boolean;
  customMetaKeys: string[];
  unresolvedFields?: UnresolvedMetadataField[];
}

export interface NextSegmentConfigContract {
  dynamic?: 'auto' | 'force-dynamic' | 'error' | 'force-static' | string;
  dynamicParams?: boolean;
  revalidate?: false | 0 | number;
  fetchCache?: 'auto' | 'default-cache' | 'only-cache' | 'force-cache' | 'force-no-store' | 'default-no-store' | 'only-no-store' | string;
  runtime?: 'nodejs' | 'edge' | string;
  preferredRegion?: string | string[];
  maxDuration?: number;
  hasGenerateMetadata?: boolean;
  hasGenerateStaticParams?: boolean;
  unresolvedFields?: UnresolvedMetadataField[];
}

export interface NextEffectiveSegmentConfig {
  scope: 'observed-segment-config';
  config: Pick<NextSegmentConfigContract, 'revalidate' | 'runtime' | 'preferredRegion' | 'maxDuration'>;
  sources: InputDependency[];
  freshness: 'current' | 'stale';
  unresolvedFields: UnresolvedMetadataField[];
  limitations: string[];
}

export interface UnresolvedTypeInfo {
  name: string;
  kind: 'props' | 'emits';
  reason: string;
}

export interface PropUsage {
  file: string;
  tag: string;
  kind: 'attribute' | 'binding' | 'model' | 'possible-binding';
  resolution: 'resolved' | 'candidate';
  reason: string;
  sourceRef: SourceRef;
}

export interface PropImpactResult {
  status: 'partial' | 'unsupported';
  target: string;
  scope: string;
  freshness: 'unverified' | 'stale';
  inputIdentity: string;
  renderConsumerCount: number;
  unknownConsumerCount: null;
  props: Array<{
    name: string;
    confirmedConsumerCount: number;
    confirmedUsageCount: number;
    candidateConsumerCount: number;
    candidateUsageCount: number;
    omittedRenderCount: number;
    omittedConsumerCount: number;
    indeterminateRenderCount: number;
    omissions?: Array<{ file: string; sourceRef: SourceRef }>;
    risk: { renameOrRemove: 'affected' | 'unknown'; reasons: string[] };
    usages?: PropUsage[];
  }>;
  diagnostics: Array<{ file: string; code: string; reason: string }>;
  limitations: string[];
}

export interface ComponentContract {
  projectContext?: ProjectOwnershipInfo;
  component: string;
  framework: FrontendFramework | 'vue-composable' | string;
  filePath: string;
  props: ComponentPropContract[];
  /** Optional workspace enrichment; counts remain scoped and incomplete. */
  propImpact?: PropImpactResult;
  emits: ComponentEmitContract[];
  slots: string[];
  slotDetails?: ComponentSlotDetail[];
  models?: ComponentModelContract[];
  exposed?: string[];
  variants?: ComponentVariantsInfo;
  renderBoundary?: RenderBoundaryInfo;
  stateDependencies?: StateDependencyInfo;
  dataDependencies?: DataDependencyInfo;
  layoutStructure?: ComponentLayoutStructure;
  boundaryContracts?: BoundaryContract[];
  boundaryDiagnostics?: Array<{ code: string; reason: string }>;
  formContracts?: FormContract[];
  symbolOutline?: ComponentSymbolOutline;
  nuxtPageMeta?: NuxtPageMetaContract;
  nextSegmentConfig?: NextSegmentConfigContract;
  islands?: AstroIslandContract[];
  dependencies?: InputDependency[];
  unresolvedTypes?: UnresolvedTypeInfo[];
}

export interface ContractOptions {
  path?: string;
  outputFormat?: 'text' | 'json';
  workspaceRoot?: string;
}

export interface PassedPropInfo {
  propName: string;
  expression: string;
  isSpread?: boolean;
}

export interface ComponentTreeNode {
  component: string;
  filePath: string;
  alias?: string;
  isDynamic?: boolean;
  isAutoImported?: boolean;
  isCircular?: boolean;
  isPage?: boolean;
  isExternalScope?: boolean;
  isRendered?: boolean;
  isCascadingWrapper?: boolean;
  relationKind?: 'render' | 'import' | 'type' | 'dynamic-import';
  warning?: string;
  depth: number;
  passedProps?: PassedPropInfo[];
  transitiveBoundary?: 'client-hydrated (inherited from parent)' | string;
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
  /** Traversal gaps; absence does not establish complete resolution. */
  diagnostics?: Array<{
    code: 'UNRESOLVED_RENDERED_IMPORT';
    filePath: string;
    sourceHash: string;
    specifier: string;
    identifier: string;
    resolution: 'unresolved';
    reason: string;
  } | {
    code: 'AMBIGUOUS_COMPONENT';
    filePath: string;
    sourceHash: string;
    identifier: string;
    candidates: string[];
    reason: string;
  } | {
    code: 'CYCLE_TRUNCATED';
    filePath: string;
    sourceHash: string | null;
    targetPath: string;
    depth: number;
    reason: string;
  } | {
    code: 'VUE_PARSE_FAILED' | 'VUE_TEMPLATE_UNSUPPORTED';
    filePath: string;
    sourceHash: string;
    depth: number;
    reason: string;
  } | {
    code: 'VUE_DYNAMIC_COMPONENT';
    selectorKind: 'static-is' | 'bound-is' | 'dynamic-argument' | 'object-binding';
    argument: string | null;
    filePath: string;
    sourceHash: string;
    sourceRef: SourceRef;
    depth: number;
    expression: string;
    resolution: 'candidate';
    reason: string;
  } | {
    code: 'CONSUMER_INPUT_UNSUPPORTED';
    filePath: string;
    sourceHash: string;
    reason: string;
  } | {
    code: 'CONSUMER_SOURCE_READ_FAILED';
    filePath: string;
    sourceHash: null;
    reason: string;
  } | {
    code: 'MAX_DEPTH_REACHED' | 'SCOPE_BOUNDARY' | 'SOURCE_READ_FAILED' | 'UPWARD_RESULTS_TRUNCATED';
    filePath: string;
    sourceHash: null;
    depth: number;
    reason: string;
  }>;
  root: ComponentTreeNode;
  totalComponents: number;
  maxDepthReached: number;
  direction?: 'downward' | 'upward' | 'down' | 'up';
  has_more?: boolean;
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
  /** Prepared internal callers own index freshness and can avoid a duplicate preflight. */
  skipSync?: boolean;
  entryPath?: string;
  routePath?: string;
  targetPath?: string;
  scopeFilter?: string | string[];
  maxDepth?: number;
  direction?: 'downward' | 'upward' | 'down' | 'up';
  outputFormat?: 'text' | 'json';
  aliasMap?: Record<string, string>;
  includeLayouts?: boolean;
  includeProps?: boolean;
  limit?: number;
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
  engine?: 'in-memory-ast' | 'sqlite-graph-cache' | 'ast-grep' | 'template-similarity-comparator' | string;
  durationMs?: number;
  cached?: boolean;
  syncGeneration?: number;
  configFingerprint?: string;
  version?: string;
  framework?: string;
}

export interface UnusedComponentInfo {
  name: string;
  fileName: string;
  filePath: string;
  framework: FrontendFramework | 'vue-composable';
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
  scopePath?: string;
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
  | 'sveltekit'
  | 'unknown';

export type RouteType =
  | 'page'
  | 'api'
  | 'layout'
  | 'loading'
  | 'error'
  | 'not-found'
  | 'template'
  | 'default';

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
  nuxtPageMeta?: NuxtPageMetaContract;
  routeGroups?: string[];
  parallelSlot?: string;
  intercepting?: string;
  nextSegmentConfig?: NextSegmentConfigContract;
  redirect?: string;
  nextEffectiveSegmentConfig?: NextEffectiveSegmentConfig;
}

export interface RouteManifestResult {
  projectContext?: ProjectOwnershipInfo;
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
  excludeDirs?: string[];
  scopePath?: string;
  frameworkHint?: RouteFramework;
  prefix?: string;
  view?: 'summary' | 'full' | 'tree';
  outputFormat?: 'text' | 'json';
}

export interface SyncStats {
  /** Counts/parser work describe effective scope; changed scoped inputs may require workspace fallback. */
  scope?: {
    requested: string;
    effective: string;
    fallbackReason: 'INDEX_INVALIDATED' | 'DEPENDENCY_CLOSURE_UNVERIFIED' | null;
  };
  /** Actual batchParser calls in the successful sync attempt, not modified-file count. */
  parserInvocations: number;
  added: number;
  modified: number;
  deleted: number;
  unchanged: number;
  total: number;
  durationMs: number;
  syncGeneration: number;
  configFingerprint: string;
  cacheHit: boolean;
}

export interface StateImpactConsumer {
  path: string;
  isPage: boolean;
  renderBoundary?: string;
  kind: 'store' | 'context' | 'composable';
  identifier: string;
  role?: 'mutator' | 'reader';
  accessMode?: StateAccessMode;
  lineNumber?: number;
  actionsCalled?: string[];
  accessedProperties?: string[];
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
  | 'enum'
  | 'variable'
  | 'computed'
  | 'watcher'
  | 'method'
  | 'composable'
  | 'unknown';

export interface ResolvedCalleeReference {
  symbol: string;
  sourceModule?: string;
  targetFilePath?: string;
  targetRange?: {
    startLine: number;
    endLine: number;
    lineCount: number;
  };
  isResolved: boolean;
}

export interface FunctionOutlineItem {
  name: string;
  kind: Exclude<SymbolKind, 'unknown'>;
  startLine: number;
  endLine: number;
  lineCount: number;
  signature?: string;
  isExported: boolean;
  internalCalls: string[];
  resolvedCalls?: ResolvedCalleeReference[];
}

export interface ComponentSymbolOutline {
  filePath: string;
  framework: string;
  totalFunctions: number;
  functions: FunctionOutlineItem[];
  dependencies?: InputDependency[];
  _meta?: EngineMetadata;
}

export interface ExtractOutlineOptions {
  path: string;
  resolveCalls?: boolean;
  workspaceRoot?: string;
  outputFormat?: 'text' | 'json';
}

export interface SymbolSliceResult {
  symbolName: string;
  kind: SymbolKind;
  filePath: string;
  startLine: number;
  endLine: number;
  code: string;
  signature?: string;
  blastRadius?: {
    status?: 'resolved' | 'partial' | 'unknown' | 'verified';
    reason?: string;
    totalConsumers: number | null;
    callers: Array<{ filePath: string; line?: number }>;
    confirmedCallers?: Array<{ filePath: string; line?: number }>;
    candidateImporters?: Array<{ filePath: string; reason?: string }>;
    coveringTests?: string[];
    internalCalls?: string[];
    resolvedCalls?: ResolvedCalleeReference[];
    resolvedCallees?: ResolvedCalleeReference[];
  };
  isTruncated?: boolean;
  _meta?: EngineMetadata;
}

export interface SliceSymbolOptions {
  path: string;
  symbolName: string;
  workspaceRoot?: string;
  includeBlastRadius?: boolean;
  maxDisplayLines?: number;
  outputFormat?: 'text' | 'json';
}

export interface EventHandlerInfo {
  event: string;
  handlerName: string;
  line: number;
  status: 'valid' | 'broken' | 'inline-expression' | 'candidate';
  source?: 'local-function' | 'composable-return' | 'prop' | 'import' | 'unresolved' | 'nuxt-auto-import';
  evidence?: Evidence;
  outboundApi?: BoundaryContract;
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
  candidateHandlers?: EventHandlerInfo[];
  autoImportUnresolved?: string[];
  autoImportDependencies?: InputDependency[];
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
  role?: 'mutator' | 'reader';
}

export interface StateChainResult {
  identifier: string;
  entryFile?: string;
  consumers: StateChainNode[];
  dependencies: StateChainNode[];
  _meta?: EngineMetadata;
}

export interface TraceStateChainOptions {
  role?: 'all' | 'mutators' | 'readers';
  identifier: string;
  targetPath?: string;
  direction?: 'consumers' | 'dependencies' | 'both';
  maxDepth?: number;
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
  backendTargetHint?: BackendTargetHint;
  source?: 'inline' | 'imported-composable';
  viaComposable?: string;
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
  evidence?: Evidence;
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

export interface EdgePayload {
  alias?: string;
  passedProps?: PassedPropInfo[];
  listenedEvents?: string[];
  slots?: string[];
  contexts?: {
    provided?: ContextDependencyNode[];
    consumed?: ContextDependencyNode[];
  };
}

// ---------------------------------------------------------------------------
// Prescriptive Refactoring & Automated Patch Plan
// ---------------------------------------------------------------------------

export type PatchRefactorType =
  | 'rename_prop'
  | 'remove_prop'
  | 'rename_event'
  | 'remove_event'
  | 'rename_model'
  | 'remove_model'
  | 'rename_slot'
  | 'remove_slot';

export interface ComponentPatchItem {
  /** Present on generated plans; legacy items without this precondition must be regenerated. */
  sourceRef?: SourceRef;
  file: string;
  line: number;
  column: number;
  targetTag: string;
  oldSnippet: string;
  newSnippet: string;
  description: string;
}

export interface PatchOperation {
  refactorType: PatchRefactorType;
  oldName: string;
  newName?: string;
}

export interface PatchPlanOptions {
  /** Internal prepared callers may avoid a duplicate sync; they own the freshness preflight. */
  skipSync?: boolean;
  componentPath: string;
  refactorType?: PatchRefactorType;
  oldName?: string;
  newName?: string;
  targetPath?: string;
  operations?: PatchOperation[];
}

export interface TargetDeclarationCandidate {
  refactorType: PatchRefactorType;
  symbol: string;
  kind: 'prop' | 'event' | 'model' | 'slot';
  found: boolean;
  file: string;
  line?: number;
  snippet?: string;
  sourceRef?: SourceRef;
}

export interface PatchPlanResult {
  patchValidation?: { valid: boolean; validatedPatchCount: number; errors: string[] };
  component: string;
  refactorType: PatchRefactorType;
  oldName: string;
  newName?: string;
  operations?: PatchOperation[];
  targetDeclarations?: TargetDeclarationCandidate[];
  totalConsumersAudited: number;
  coverage: {
    candidateCount: number;
    analyzedCount: number;
    failedCount: number;
    unsupportedCount: number;
    analyzedWithPatchCount: number;
    analyzedWithoutPatchCount: number;
    discovery: 'graph-bounded';
    omissions: Array<{
      file: string;
      code: string;
      message: string;
      resolution: 'candidate' | 'unsupported';
      sourceRef?: SourceRef;
    }>;
    operationScope: {
      consumerUsages: 'supported-static-usages';
      targetDeclaration: 'not-included';
      forwarding: 'not-included';
      dynamicComponents: 'not-included';
    };
    diagnostics: Array<{ file: string; code: string; message: string }>;
  };
  totalPatches: number;
  patches: ComponentPatchItem[];
  preconditionsValidated?: boolean;
  _meta?: EngineMetadata;
}

// ---------------------------------------------------------------------------
// Cross-Boundary API Contract Extractor
// ---------------------------------------------------------------------------

export type ApiMethod =
  | 'GET'
  | 'POST'
  | 'PUT'
  | 'PATCH'
  | 'DELETE'
  | 'HEAD'
  | 'OPTIONS'
  | 'UNKNOWN';

export type ApiClientKind =
  | 'fetch'
  | 'axios'
  | 'useFetch'
  | 'useQuery'
  | 'useMutation'
  | '$fetch'
  | 'custom';

export interface BackendTargetHint {
  targetIntent: string;
  routePattern: string;
  suggestedSymbols: string[];
  namedRoute?: string;
  isHeuristic?: boolean;
  disclaimer?: string;
}

export interface ApiContractItem {
  file: string;
  line: number;
  column: number;
  endpoint: string;
  method: ApiMethod;
  clientKind: ApiClientKind;
  payloadParams?: string[];
  callerFunction?: string;
  backendTargetHint?: BackendTargetHint;
  source?: 'inline' | 'imported-composable';
  viaComposable?: string;
}

export interface ApiContractResult {
  workspaceRoot: string;
  totalEndpointsFound: number;
  endpoints: ApiContractItem[];
  endpointSummary: Record<string, { methods: ApiMethod[]; callers: string[] }>;
  _meta?: EngineMetadata;
}

export interface ExtractedImport {
  name: string;
  alias?: string;
  exportedName?: string;
  source: string;
  isDynamic: boolean;
}

export interface ExtractApiContractsOptions {
  targetPath?: string;
  scopePath?: string;
  excludeDirs?: string[];
}
