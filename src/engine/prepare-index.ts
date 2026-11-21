import { syncWorkspace } from './storage/delta-sync';
import { isWorkspaceIndexed } from './storage/schema';
import { observeRetrievalIndex, type IndexObservation } from './index-retrieval-evidence';
import { checkAnalysisCancelled } from './analysis-context';

export { isWorkspaceIndexed };

/** Optional preparation preserves source-only operations on uninitialized workspaces. */
export async function prepareIndexedAnalysis(workspace: string, optional = false): Promise<IndexObservation | null> {
  checkAnalysisCancelled();
  if (optional && !isWorkspaceIndexed(workspace)) return null;
  await syncWorkspace(workspace);
  checkAnalysisCancelled();
  const observation = observeRetrievalIndex(workspace);
  if (!observation) throw new Error('INDEX_OBSERVATION_UNAVAILABLE: refreshed index could not be observed');
  return observation;
}
