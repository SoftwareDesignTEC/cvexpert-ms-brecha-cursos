import type { CourseDiscoveryProvider, CourseTopic } from '../course-discovery/model.js';
import { fromDiscovery, type Snapshot, type SyncPlan, type SyncRun } from './model.js';
import { reconcile } from './reconcile.js';

// Read-only port. There is intentionally no save/apply operation in Phase 1.
export interface CatalogSnapshotReader { load(): Promise<Snapshot> }

// A topic search cannot certify a complete provider catalog, even if it has no next page.
export async function planDiscoveryQuery<Q extends CourseTopic>(provider: CourseDiscoveryProvider<Q>, query: Q,
    reader: CatalogSnapshotReader, run: Pick<SyncRun, 'runId' | 'observedAt'>): Promise<SyncPlan> {
    const snapshot = await reader.load();
    const base: SyncRun = { ...run, sourceId: provider.name, scope: 'query', status: 'failed', valid: false,
        missingPages: false, quotaLimited: false, errors: ['PROVIDER_FAILED'], candidates: [] };
    let page;
    try { page = await provider.search(query, async () => {}); }
    catch { return reconcile(snapshot, base); }
    return reconcile(snapshot, { ...base, status: page.truncated ? 'partial' : 'complete',
        valid: page.rejected === 0, missingPages: page.truncated, errors: page.rejected ? ['REJECTED_RECORDS'] : [],
        candidates: page.candidates.map(fromDiscovery) });
}
