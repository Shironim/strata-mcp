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

export interface ComponentContract {
  component: string;
  framework: 'vue' | 'react' | 'astro' | 'unknown';
  filePath: string;
  props: ComponentPropContract[];
  emits: ComponentEmitContract[];
  slots: string[];
  exposed?: string[];
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
  depth: number;
  children: ComponentTreeNode[];
}

export interface ComponentTreeResult {
  root: ComponentTreeNode;
  totalComponents: number;
  maxDepthReached: number;
}

export interface ComponentTreeOptions {
  entryPath: string;
  maxDepth?: number;
  outputFormat?: 'text' | 'json';
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
