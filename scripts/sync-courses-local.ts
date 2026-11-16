import { pathToFileURL } from 'node:url';
import { Pool, type PoolConfig } from 'pg';
import { readJson } from './course-discovery/store.js';
import type { SyncRun } from './course-sync/model.js';
import { assertLocalTarget, createPostgresStaging } from './course-sync/postgres.js';

export function localSyncConfig(env: NodeJS.ProcessEnv): PoolConfig {
    const target = { host: env.COURSE_SYNC_HOST, database: env.COURSE_SYNC_DATABASE, user: env.COURSE_SYNC_USER };
    assertLocalTarget(target);
    const port = Number(env.COURSE_SYNC_PORT);
    if (!['test','development'].includes(env.NODE_ENV ?? '') || !env.COURSE_SYNC_PASSWORD
        || env.COURSE_SYNC_CONFIRM_DISPOSABLE !== target.database || !Number.isInteger(port) || port < 1 || port > 65535
        || env.WEBSITE_INSTANCE_ID || env.WEBSITE_SITE_NAME) throw new Error('EXPLICIT_LOCAL_DISPOSABLE_CONFIG_REQUIRED');
    return { ...target, port, password: env.COURSE_SYNC_PASSWORD, ssl: false, max: 2,
        connectionTimeoutMillis: 5000, statement_timeout: 15000,
        options: '-c search_path=pg_catalog -c idle_in_transaction_session_timeout=30000',
        application_name: 'cvexpert-course-sync-local-staging' };
}
export async function runLocalSync(args: string[], env = process.env) {
    if (args.length !== 2 || args[0] !== '--apply-local') throw new Error('Use --apply-local <run.json>');
    const config = localSyncConfig(env); // Validate before opening file or socket; never loads .env or PG*.
    const run = await readJson(args[1]!);
    const pool = new Pool(config);
    try { return await createPostgresStaging(pool).execute(run as SyncRun); }
    finally { await pool.end(); }
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
    runLocalSync(process.argv.slice(2)).then(r => console.log(JSON.stringify(r,null,2)))
        .catch(() => { console.error('Course Sync local falló; revisar destino, permisos y ejecución.'); process.exitCode = 1; });
}
