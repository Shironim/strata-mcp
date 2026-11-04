import { readSourceSnapshot } from './source-file';
import type { NextEffectiveSegmentConfig, NextSegmentConfigContract } from '../types';

/** Observed segment exports only; request-time caching and fetch dataflow are separate. */
export async function deriveNextEffectiveConfig(
  files: string[],
  extract: (content: string) => NextSegmentConfigContract | undefined,
): Promise<NextEffectiveSegmentConfig> {
  const result: NextEffectiveSegmentConfig = {
    scope: 'observed-segment-config', config: {}, sources: [], freshness: 'current', unresolvedFields: [],
    limitations: [
      'Covers observed layout/page segment exports only; fetch-level revalidation and dynamic request dataflow may change route behavior.',
      'Next version, next.config, cacheComponents, compiler validity and deployment-platform behavior are unverified.',
      'Source hashes were rechecked after traversal; this is not an atomic workspace or directory-membership snapshot.',
    ],
  };
  let revalidate: number | false | undefined;
  let unknownRevalidate = false;
  let unknownRuntime = false;
  for (const path of [...new Set(files)]) {
    let metadata: NextSegmentConfigContract | undefined;
    try {
      const source = await readSourceSnapshot(path);
      result.sources.push({ path, hash: source.snapshot.sha256, isExternal: false });
      metadata = extract(source.content);
    } catch {
      result.freshness = 'stale';
      metadata = { unresolvedFields: [{ field: '*', expression: path, reason: 'Segment source could not be read.' }] };
    }
    for (const issue of metadata?.unresolvedFields ?? []) result.unresolvedFields.push({ ...issue, reason: `${path}: ${issue.reason}` });
    const unknown = (field: string) => metadata?.unresolvedFields?.some(issue => issue.field === field || issue.field === '*');
    if (metadata?.runtime !== undefined) unknownRuntime = false;
    else if (unknown('runtime')) unknownRuntime = true;
    for (const field of ['runtime', 'preferredRegion', 'maxDuration'] as const) {
      if (metadata?.[field] !== undefined) Object.assign(result.config, { [field]: metadata[field] });
      else if (unknown(field)) delete result.config[field];
    }
    if (metadata?.revalidate !== undefined) {
      const value = metadata.revalidate;
      revalidate = revalidate === undefined ? value : value === false ? revalidate : revalidate === false ? value : Math.min(revalidate, value);
    } else if (unknown('revalidate')) unknownRevalidate = true;
    for (const field of ['dynamic', 'dynamicParams', 'fetchCache'] as const) {
      if (metadata?.[field] !== undefined) result.unresolvedFields.push({ field, expression: String(metadata[field]),
        reason: `${path}: Cross-segment dynamic/fetch-cache policy compatibility and request behavior are not derived.` });
    }
  }
  if (!unknownRevalidate && revalidate !== undefined) result.config.revalidate = revalidate;
  if (unknownRuntime && revalidate !== undefined) {
    delete result.config.revalidate;
    result.unresolvedFields.push({ field: 'revalidate', expression: String(revalidate), reason: 'Effective runtime is unresolved; revalidate applicability is not established.' });
  }
  if (result.config.runtime === 'edge' && revalidate !== undefined) {
    delete result.config.revalidate;
    result.unresolvedFields.push({ field: 'revalidate', expression: String(revalidate), reason: 'Revalidate is unavailable with edge runtime; no effective caching behavior is certified.' });
  }
  for (const source of result.sources) {
    try { if ((await readSourceSnapshot(source.path)).snapshot.sha256 !== source.hash) result.freshness = 'stale'; }
    catch { result.freshness = 'stale'; }
  }
  return result;
}
