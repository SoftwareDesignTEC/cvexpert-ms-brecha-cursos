import { discoverCourses } from '../course-discovery/service.js';
import type { DiscoveryConfig } from '../course-discovery/model.js';
import { emptyState, type DiscoveryState, type DiscoveryStore } from '../course-discovery/store.js';
import { SaylorProvider, type SaylorQuery } from '../course-discovery/saylor-provider.js';
import { fromDiscovery, type Snapshot } from './model.js';
import { reconcile } from './reconcile.js';

export function saylorFixtureConfig(queries: SaylorQuery[]): DiscoveryConfig<SaylorQuery> {
    return { enabled: false, locale: 'en-us', intervalHours: 24, cacheHours: 6, timeoutMs: 10000,
        maxRequestsPerRun: 1, maxRequestsPerDay: 3, minRequestIntervalMs: 2000, maxPages: 1, pageSize: 100, queries };
}
export function memoryDiscoveryStore(): DiscoveryStore {
    let state: DiscoveryState = emptyState();
    return { async load() { return structuredClone(state); }, async save(next) { state = structuredClone(next); } };
}
export async function planSaylorDiscovery(provider: SaylorProvider, snapshot: Snapshot,
    config: DiscoveryConfig<SaylorQuery>, store: DiscoveryStore, runId: string, now: () => number) {
    const discovery = await discoverCourses(provider, config, store, { mode: 'fixture' }, now, async () => {});
    const complete = discovery.status === 'completed';
    const partial = discovery.queries.some(q => q.truncated || q.rejected || q.status === 'deferred');
    const plan = reconcile(snapshot, { runId, sourceId: provider.name, observedAt: new Date(now()).toISOString(),
        scope: 'query', status: complete && !partial ? 'complete' : complete ? 'partial' : 'failed',
        valid: complete && !discovery.queries.some(q => q.rejected),
        missingPages: partial, quotaLimited: discovery.queries.some(q => q.error === 'QUERY_BUDGET_EXHAUSTED' || q.error === 'RATE_LIMITED'),
        errors: complete ? [] : ['DISCOVERY_NOT_COMPLETE'], candidates: discovery.candidates.map(fromDiscovery) });
    return { dataSource: 'TEST_SYNTHETIC_ONLY', liveEnabled: false, databaseAccess: false,
        publicationApproved: false, coverage: 'unverified', discovery, plan } as const;
}
