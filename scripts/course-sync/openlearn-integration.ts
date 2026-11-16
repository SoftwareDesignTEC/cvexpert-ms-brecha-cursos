import { DiscoveryError, text } from '../course-discovery/model.js';
import { OpenLearnProvider, openLearnLimit } from '../course-discovery/openlearn-provider.js';
import { fromDiscovery, type SyncRun } from './model.js';
import type { CourseSyncStaging } from './persistence.js';
import { normalize, timestamp } from './validation.js';

export interface PreparedOpenLearnRun {
    formatVersion: 1;
    kind: 'openlearn-staging-query';
    run: SyncRun;
    rejected: { index: number; code: string }[];
}
function rejectionErrors(rejected: PreparedOpenLearnRun['rejected']): string[] {
    return rejected.length ? ['REJECTED_RECORDS',...rejected.map(e => `REJECTED_RECORD:${e.index}:${e.code}`)] : [];
}
// No reconciliation here: the staging port owns snapshot + reconcile + COMMIT.
// The caller owns ONE provider instance and must retain this run for every retry.
export async function discoverOpenLearn(provider: OpenLearnProvider, input: Pick<SyncRun,'runId' | 'observedAt'>): Promise<PreparedOpenLearnRun> {
    text(input.runId); timestamp(input.observedAt);
    const run: SyncRun = { ...input,sourceId: 'openlearn',scope: 'query',status: 'failed',valid: false,
        missingPages: true,quotaLimited: false,errors: [],candidates: [] };
    try {
        const page = await provider.search({ skill: 'OpenLearn bounded metadata; no skill associations' },async () => {});
        run.status = 'partial'; // LIMIT 10 is never evidence of complete coverage.
        run.valid = page.rejected === 0;
        run.errors = rejectionErrors(provider.lastObservation?.rejected ?? []);
        run.candidates = page.candidates.map(fromDiscovery);
    } catch (error) {
        const code = error instanceof DiscoveryError ? error.code : 'PROVIDER_FAILED';
        run.status = 'failed'; run.valid = false; run.candidates = [];
        run.errors = [code]; run.quotaLimited = ['RATE_LIMITED','QUERY_BUDGET_EXHAUSTED'].includes(code);
    }
    return { formatVersion: 1,kind: 'openlearn-staging-query',run,
        rejected: run.status === 'failed' ? [] : provider.lastObservation?.rejected ?? [] };
}

export function parsePreparedOpenLearn(value: unknown): PreparedOpenLearnRun {
    const p = value as PreparedOpenLearnRun, r = p?.run;
    if (!p || p.formatVersion !== 1 || p.kind !== 'openlearn-staging-query' || !r
        || r.sourceId !== 'openlearn' || r.scope !== 'query' || r.missingPages !== true
        || !['partial','failed'].includes(r.status) || typeof r.valid !== 'boolean' || typeof r.quotaLimited !== 'boolean'
        || !Array.isArray(r.errors) || !Array.isArray(r.candidates) || r.candidates.length > openLearnLimit
        || !Array.isArray(p.rejected) || p.rejected.length + r.candidates.length > openLearnLimit
        || (r.status === 'failed' && (r.valid || !r.errors.length || r.candidates.length || p.rejected.length))
        || (r.status === 'partial' && (r.valid !== (p.rejected.length === 0) || r.quotaLimited))) throw new Error('INVALID_OPENLEARN_RUN');
    text(r.runId); timestamp(r.observedAt); r.errors.forEach(e => text(e,100));
    p.rejected.forEach(e => { if (!e || !Number.isInteger(e.index) || e.index < 0 || e.index >= openLearnLimit) throw new Error('INVALID_REJECTION'); text(e.code,100); });
    if (r.status === 'partial' && JSON.stringify(r.errors) !== JSON.stringify(rejectionErrors(p.rejected))) throw new Error('INVALID_OPENLEARN_RUN');
    for (const raw of r.candidates) {
        const c = normalize(raw,r.sourceId,r.observedAt);
        if (c.associatedSkills.length) throw new Error('OPENLEARN_SKILLS_REQUIRE_EDITORIAL_REVIEW');
    }
    return structuredClone(p);
}
export async function ingestOpenLearn(value: unknown, staging: CourseSyncStaging) {
    const prepared = parsePreparedOpenLearn(value);
    const result = await staging.execute(prepared.run);
    const counts = { inserts: 0,updates: 0,unchanged: 0,duplicates: 0,rejected: prepared.rejected.length,conflicts: 0 };
    for (const a of result.actions) {
        if (a.kind === 'insert') counts.inserts++;
        if (a.kind === 'update') counts.updates++;
        if (a.kind === 'unchanged') counts.unchanged++;
        if (a.kind === 'duplicate') counts.duplicates++;
        if (a.kind === 'invalid') counts.rejected++;
        if (['ambiguous','manual_protected'].includes(a.kind)) counts.conflicts++;
    }
    const state = await staging.load();
    return { sourceId: 'openlearn',runId: prepared.run.runId,status: prepared.run.status,coverage: 'bounded_query_only',
        publicationApproved: false,counts,result,
        attribution: { creator: 'The Open University',dataset: 'OpenLearn metadata',source: 'https://data.open.ac.uk/datasets#openlearn',
            license: 'https://creativecommons.org/licenses/by/3.0/',changes: 'Validated metadata transformed into staging proposals; no endorsement implied.' },
        candidates: state.snapshot.courses.filter(c => c.course.sourceId === 'openlearn').map(c =>
            ({ candidateId: c.internalId,version: state.versions[c.internalId],observed: c.course,missingCount: c.missingCount })),
        history: await staging.history('openlearn') };
}
