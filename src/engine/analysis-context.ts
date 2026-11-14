import { AsyncLocalStorage } from 'node:async_hooks';
import type ts from 'typescript';

interface AnalysisContext {
  signal?: AbortSignal;
  syntax: Map<string, ts.SourceFile>;
  syntaxBytes: number;
}

const contexts = new AsyncLocalStorage<AnalysisContext>();

export function withAnalysisContext<T>(operation: () => T, signal?: AbortSignal): T {
  return contexts.getStore() && !signal
    ? operation()
    : contexts.run({ signal, syntax: new Map(), syntaxBytes: 0 }, operation);
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
