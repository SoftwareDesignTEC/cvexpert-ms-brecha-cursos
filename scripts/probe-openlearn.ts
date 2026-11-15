import { createHash } from 'node:crypto';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { DiscoveryError, type CourseDiscoveryProvider, type CourseTopic } from './course-discovery/model.js';
import { OpenLearnProvider, openLearnEndpoint, openLearnGraph, openLearnLimit, openLearnSelect } from './course-discovery/openlearn-provider.js';
import { planDiscoveryQuery } from './course-sync/worker.js';
import type { Snapshot } from './course-sync/model.js';

export function parseOpenLearnArguments(args: string[]) {
    if (new Set(args).size !== args.length || args.some(a => !['--fixture', '--live', '--dry-run'].includes(a))
        || (args.includes('--fixture') && args.includes('--live'))) throw new DiscoveryError('INVALID_ARGUMENTS');
    return args.includes('--live') ? 'live' : 'fixture';
}
interface Dependencies { request?: typeof fetch; now?: () => number; env?: NodeJS.ProcessEnv }
export async function runOpenLearnProbe(args: string[], dependencies: Dependencies = {}) {
    const mode = parseOpenLearnArguments(args), env = dependencies.env ?? process.env;
    if (mode === 'live' && (env.CI || env.GITHUB_ACTIONS || env.TF_BUILD || env.NODE_ENV === 'test'
        || env.NODE_ENV === 'production' || env.WEBSITE_INSTANCE_ID || env.WEBSITE_SITE_NAME)) throw new DiscoveryError('LOCAL_PROBE_ONLY');
    let now = dependencies.now ?? Date.now, request = dependencies.request;
    let snapshot: Snapshot = { courses: [], checkpoints: {} };
    if (mode === 'fixture') {
        const fixture = await import('../test/fixtures/openlearn.test.js');
        now = dependencies.now ?? (() => Date.parse(fixture.openLearnTestTime));
        request ??= async () => new Response(JSON.stringify(fixture.openLearnFixture()), { headers: { 'content-type': 'application/sparql-results+json' } });
        snapshot = fixture.openLearnTestSnapshot();
    }
    // One shared observation timestamp for this bounded request and the Phase 1
    // worker. It records probe start, avoiding future observations versus its run.
    const startedAt = now(), provider = new OpenLearnProvider({ mode }, request, () => startedAt);
    let failure: DiscoveryError | undefined;
    // Reuse the Phase 1 query worker unchanged; observe safe failures for the probe report.
    const observedProvider: CourseDiscoveryProvider<CourseTopic> = { name: provider.name, async search(query, beforeRequest) {
        try { return await provider.search(query, beforeRequest); }
        catch (error) { failure = error instanceof DiscoveryError ? error : new DiscoveryError('PROVIDER_FAILED'); throw failure; }
    } };
    const at = new Date(startedAt).toISOString();
    const plan = await planDiscoveryQuery(observedProvider, { skill: 'OpenLearn metadata probe; no skill associations' },
        { load: async () => structuredClone(snapshot) }, { runId: `openlearn-probe:${mode}:${at}`, observedAt: at });
    const observation = provider.lastObservation;
    return { mode: 'dry-run', transport: mode, status: failure ? 'failed' : observation?.rejected.length ? 'completed_with_rejections' : 'completed',
        dataSource: mode === 'fixture' ? 'TEST_SYNTHETIC_ONLY' : 'PUBLIC_OPENLEARN_METADATA',
        at, sourceId: provider.name, endpoint: openLearnEndpoint, graph: openLearnGraph, limit: openLearnLimit,
        requests: provider.requests, query: openLearnSelect, querySha256: createHash('sha256').update(openLearnSelect).digest('hex'),
        coverage: 'bounded_query_only', periodicSyncApproved: false, databaseAccess: false, publicationApproved: false,
        attribution: { creator: 'The Open University', dataset: 'OpenLearn metadata', source: 'https://data.open.ac.uk/datasets#openlearn',
            license: 'https://creativecommons.org/licenses/by/3.0/', changes: 'Selected fields; validated and transformed to review proposals. No endorsement implied.' },
        error: failure ? { code: failure.code, retryAfterMs: failure.retryAfterMs } : null, observation, plan };
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
    runOpenLearnProbe(process.argv.slice(2)).then(report => {
        console.log(JSON.stringify(report, null, 2));
        if (report.status === 'failed') process.exitCode = 1;
    }).catch(error => {
        console.error(JSON.stringify({ error: error instanceof DiscoveryError ? error.code : 'OPENLEARN_PROBE_FAILED' }));
        process.exitCode = 1;
    });
}
