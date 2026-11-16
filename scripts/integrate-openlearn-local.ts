import { open } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';
import { Pool } from 'pg';
import { OpenLearnProvider } from './course-discovery/openlearn-provider.js';
import { readJson } from './course-discovery/store.js';
import { discoverOpenLearn, ingestOpenLearn } from './course-sync/openlearn-integration.js';
import { createPostgresStaging } from './course-sync/postgres.js';
import { localSyncConfig } from './sync-courses-local.js';

export async function prepareOpenLearnFixture() {
    const f = await import('../test/fixtures/openlearn.test.js');
    const provider = new OpenLearnProvider({ mode: 'fixture' },async () =>
        new Response(JSON.stringify(f.openLearnFixture()),{ headers: { 'content-type': 'application/sparql-results+json' } }),
    () => Date.parse(f.openLearnTestTime));
    return discoverOpenLearn(provider,{ runId: `TEST-openlearn-integration:${f.openLearnTestTime}`,observedAt: f.openLearnTestTime });
}
export async function runOpenLearnIntegration(args: string[], env = process.env) {
    // Live transport is deliberately absent. The separate existing probe keeps its guards.
    if (!args.length || args.length === 1 && args[0] === '--fixture') {
        return { mode: 'dry-run',transport: 'fixture',databaseAccess: false,publicationApproved: false,prepared: await prepareOpenLearnFixture() };
    }
    if (args.length === 2 && args[0] === '--prepare') {
        const file = await open(args[1]!,'wx',0o600);
        try { const prepared = await prepareOpenLearnFixture(); await file.writeFile(JSON.stringify(prepared,null,2) + '\n'); await file.sync();
            return { mode: 'prepared',transport: 'fixture',databaseAccess: false,publicationApproved: false,prepared }; }
        finally { await file.close(); }
    }
    if (!(args.length === 2 && args[0] === '--apply-local' || args.length === 1 && args[0] === '--history-local')) throw new Error('INVALID_ARGUMENTS');
    const config = localSyncConfig(env); // Before reading a run or opening a socket; no PG* or .env.
    const prepared = args[0] === '--apply-local' ? await readJson(args[1]!) : undefined;
    const pool = new Pool(config);
    try {
        const staging = createPostgresStaging(pool);
        return prepared === undefined ? { sourceId: 'openlearn',history: await staging.history('openlearn') }
            : await ingestOpenLearn(prepared,staging);
    } finally { await pool.end(); }
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
    runOpenLearnIntegration(process.argv.slice(2)).then(report => {
        console.log(JSON.stringify(report,null,2));
        if ('status' in report && report.status === 'failed') process.exitCode = 1;
    }).catch(() => { console.error('OPENLEARN_LOCAL_INTEGRATION_FAILED'); process.exitCode = 1; });
}
