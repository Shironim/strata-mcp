import type { RenderBoundaryInfo } from '../types';

/** Local syntax candidates must not become proof of a runtime render environment. */
export function renderBoundaryOmission(boundary?: RenderBoundaryInfo): { code: string; reason: string } | undefined {
  if (!boundary) return;
  const evidence = boundary.evidence;
  if (boundary.boundary === 'unknown' || !evidence || evidence.resolution !== 'resolved') {
    const partial = boundary.boundary !== 'unknown' && evidence?.resolution === 'candidate';
    return {
      code: partial ? 'RENDER_BOUNDARY_PARTIAL' : 'RENDER_BOUNDARY_UNVERIFIED',
      reason: `${boundary.boundary}: ${evidence?.reason ?? 'No render-boundary evidence was established.'} The hydration flag is a structural interpretation, not an observed runtime result.`,
    };
  }
}
