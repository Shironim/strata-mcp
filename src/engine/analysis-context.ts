import { AsyncLocalStorage } from 'node:async_hooks';
import type ts from 'typescript';

export type ProgressReporter = (progress: number, total?: number, message?: string) => void;

interface AnalysisContext {
  signal?: AbortSignal;
  onProgress?: ProgressReporter;
  syntax: Map<string, ts.SourceFile>;
  syntaxBytes: number;
}

const contexts = new AsyncLocalStorage<AnalysisContext>();

export function withAnalysisContext<T>(
  operation: () => T,
  signal?: AbortSignal,
  onProgress?: ProgressReporter
): T {
  return contexts.getStore() && !signal && !onProgress
    ? operation()
    : contexts.run({ signal, onProgress, syntax: new Map(), syntaxBytes: 0 }, operation);
}

export function reportAnalysisProgress(progress: number, total?: number, message?: string): void {
  contexts.getStore()?.onProgress?.(progress, total, message);
}

export function analysisSignal(): AbortSignal | undefined {
  return contexts.getStore()?.signal;
}

export function checkAnalysisCancelled(): void {
  analysisSignal()?.throwIfAborted();
}

export function analysisSyntaxCache(): Pick<AnalysisContext, 'syntax' | 'syntaxBytes'> | undefined {
  return contexts.getStore();
}
