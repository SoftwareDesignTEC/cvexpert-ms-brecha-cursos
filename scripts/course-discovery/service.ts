import { createHash } from 'node:crypto';
import { setTimeout as sleep } from 'node:timers/promises';
import type { CatalogDocument } from '../catalog-import/document.js';
import { consolidateCandidates, DiscoveryError, type CourseCandidate, type CourseTopic, type CourseDiscoveryProvider, type DiscoveryConfig } from './model.js';
import type { DiscoveryStore } from './store.js';

export async function discoverCourses<Query extends CourseTopic>(provider: CourseDiscoveryProvider<Query>, config: DiscoveryConfig<Query>,
    store: DiscoveryStore, options: { mode: 'fixture' | 'live'; scheduled?: boolean; catalog?: CatalogDocument },
    now: () => number = Date.now, delay: (ms: number) => Promise<unknown> = sleep) {
    const state = await store.load();
    const startedAt = now();
    const report = { formatVersion: 1, kind: 'course-discovery-proposals', mode: 'dry-run',
        dataSource: options.mode === 'fixture' ? 'deterministic_test_fixture' : 'authenticated_provider',
        generatedAt: new Date(startedAt).toISOString(), provider: provider.name,
        status: 'completed', requests: 0, queries: [] as { skill: string; status: string; error?: string; rejected?: number; truncated?: boolean }[],
        candidates: [] as CourseCandidate[], publicationApproved: false, databaseAccess: false };
    if ((options.scheduled || options.mode === 'live') && !config.enabled) return { ...report, status: 'disabled' };
    if (options.scheduled && startedAt < state.lastRunAt + config.intervalHours * 3600000) return { ...report, status: 'not_due' };
    if (startedAt < state.blockedUntil) return { ...report, status: 'provider_backoff' };
    // La selección/configuración nueva no reinicia la cuota diaria.
    const day = new Date(startedAt).toISOString().slice(0, 10);
    if (state.day !== day) { state.day = day; state.requests = 0; }
    const candidates: CourseCandidate[] = [];
    let stop = false;
    for (const query of config.queries) {
        if (stop) { report.queries.push({ skill: query.skill, status: 'deferred' }); continue; }
        const key = createHash('sha256').update(JSON.stringify([provider.name, config.locale, config.pageSize,
            config.maxPages, query])).digest('hex');
        const cached = state.cache[key];
        if (cached && startedAt >= cached.queriedAt && startedAt - cached.queriedAt < config.cacheHours * 3600000) {
            candidates.push(...cached.candidates);
            report.queries.push({ skill: query.skill, status: 'cached', rejected: cached.rejected, truncated: cached.truncated });
            continue;
        }
        try {
            const found = await provider.search(query, async () => {
                if (report.requests >= config.maxRequestsPerRun) throw new DiscoveryError('QUERY_BUDGET_EXHAUSTED');
                const wait = state.lastRequestAt + config.minRequestIntervalMs - now();
                if (wait > 0) await delay(wait);
                const requestDay = new Date(now()).toISOString().slice(0, 10);
                if (state.day !== requestDay) { state.day = requestDay; state.requests = 0; }
                if (state.requests >= config.maxRequestsPerDay) throw new DiscoveryError('QUERY_BUDGET_EXHAUSTED');
                state.lastRequestAt = now();
                state.requests++;
                report.requests++;
                await store.save(state); // Si falla el disco, no se realiza la llamada externa.
            });
            state.cache[key] = { queriedAt: now(), ...found };
            // Retención acotada; nunca borrar cursos publicados ni caché por fallo del proveedor.
            const keys = Object.keys(state.cache).sort((a, b) => state.cache[b]!.queriedAt - state.cache[a]!.queriedAt);
            for (const old of keys.slice(20)) delete state.cache[old];
            await store.save(state);
            candidates.push(...found.candidates);
            report.queries.push({ skill: query.skill, status: 'fetched', rejected: found.rejected, truncated: found.truncated });
        } catch (error) {
            const failure = error instanceof DiscoveryError ? error : new DiscoveryError('DISCOVERY_FAILED');
            report.status = 'partial_failure';
            report.queries.push({ skill: query.skill, status: 'failed', error: failure.code });
            if (failure.retryAfterMs > 0) { state.blockedUntil = now() + failure.retryAfterMs; await store.save(state); }
            stop = failure.retryAfterMs > 0 || ['QUERY_BUDGET_EXHAUSTED', 'PROVIDER_UNAUTHORIZED', 'CREDENTIALS_REQUIRED'].includes(failure.code);
        }
    }
    report.candidates = consolidateCandidates(candidates, options.catalog);
    // Un fallo no retrasa la planificación durante un intervalo completo; sí respeta backoff.
    if (report.status === 'completed') state.lastRunAt = startedAt;
    await store.save(state);
    return report;
}
