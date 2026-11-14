import ts from 'typescript';
import { createHash } from 'node:crypto';
import { analysisSyntaxCache, checkAnalysisCancelled } from './analysis-context';

/** AST reuse is limited to one request and exact source text; source rechecks still read disk. */
export function parseTypeScript(file: string, content: string, kind: ts.ScriptKind = ts.ScriptKind.TSX): ts.SourceFile {
  checkAnalysisCancelled();
  const cache = analysisSyntaxCache();
  const key = cache ? `${kind}\0${file}\0${createHash('sha256').update(content).digest('hex')}` : '';
  const existing = cache?.syntax.get(key);
  if (existing) return existing;
  const source = ts.createSourceFile(file, content, ts.ScriptTarget.Latest, true, kind);
  const bytes = content.length * 2;
  if (cache && cache.syntax.size < 32 && cache.syntaxBytes + bytes <= 2 * 1024 * 1024) {
    cache.syntax.set(key, source);
    cache.syntaxBytes += bytes;
  }
  return source;
}
