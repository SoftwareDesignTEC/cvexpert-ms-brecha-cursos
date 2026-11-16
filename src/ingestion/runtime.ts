import { Pool, type PoolConfig } from 'pg';
import { getDatabaseConfig } from '../db/config.js';
import { discoverOpenLearn, discoverFreeCodeCamp, IngestError, type Provider, type Discovery } from './providers.js';
import { insertDiscoveredCourses, verifyIngestIdentity, type AppliedSource } from './catalog.js';

export function ingestionConfig(env: NodeJS.ProcessEnv): PoolConfig {
    for (const key of ['HOST','PORT','DATABASE','USER','PASSWORD']) if (!env[`COURSES_INGEST_${key}`]) throw new IngestError('EXPLICIT_INGEST_CONFIG_REQUIRED');
    if (env.COURSES_INGEST_USER !== 'cvexpert_course_ingest') throw new IngestError('LIMITED_INGEST_IDENTITY_REQUIRED');
    const local = ['127.0.0.1','::1','localhost'].includes(env.COURSES_INGEST_HOST!);
    if (env.COURSES_INGEST_SSL_MODE === 'disable' && !local) throw new IngestError('REMOTE_TLS_REQUIRED');
    return { ...getDatabaseConfig({ ...env,PGHOST: env.COURSES_INGEST_HOST,PGPORT: env.COURSES_INGEST_PORT,
        PGDATABASE: env.COURSES_INGEST_DATABASE,PGUSER: env.COURSES_INGEST_USER,PGPASSWORD: env.COURSES_INGEST_PASSWORD,
        DB_SSL_MODE: env.COURSES_INGEST_SSL_MODE ?? 'verify-full',PGSSLROOTCERT: env.COURSES_INGEST_SSLROOTCERT ?? '' }),
        max: 1,application_name: 'cvexpert-automatic-course-ingest',options: '-c search_path=pg_catalog -c idle_in_transaction_session_timeout=30000' };
}
export interface IngestionReport {
    synchronizedAt: string; status: 'complete' | 'partial' | 'failed' | 'locked';
    sources: (AppliedSource | { provider: Provider; error: string; retryAfterMs: number })[];
}
export async function ingestOnce(pool: Pool, discover: { openlearn: () => Promise<Discovery>; freecodecamp: () => Promise<Discovery> } = {
    openlearn: discoverOpenLearn,freecodecamp: discoverFreeCodeCamp,
}): Promise<IngestionReport> {
    const client = await pool.connect(); let locked = false;
    const report: IngestionReport = { synchronizedAt: new Date().toISOString(),status: 'locked',sources: [] };
    try {
        await verifyIngestIdentity(client); // Reject privileged/API identities BEFORE any external request or DML.
        locked = (await client.query('SELECT pg_try_advisory_lock(834921,6) AS locked')).rows[0].locked;
        if (!locked) return report;
        for (const provider of ['openlearn','freecodecamp'] as const) {
            try { report.sources.push(await insertDiscoveredCourses(client,await discover[provider]())); }
            catch (e) { report.sources.push({ provider,error: e instanceof IngestError ? e.code
                : (e as NodeJS.ErrnoException).code === '40001' ? 'SERIALIZATION_RETRY_NEXT_RUN' : 'PROVIDER_OR_DATABASE_FAILED',
                retryAfterMs: e instanceof IngestError ? e.retryAfterMs : 0 }); }
        }
        const success = report.sources.filter(s => !('error' in s)).length;
        report.status = success === 2 ? 'complete' : success ? 'partial' : 'failed'; return report;
    } finally {
        let destroy = false;
        if (locked) try { await client.query('SELECT pg_advisory_unlock(834921,6)'); } catch { destroy = true; }
        client.release(destroy);
    }
}
export async function ingestConfigured(env = process.env) {
    const pool = new Pool(ingestionConfig(env)); pool.on('error',() => {});
    try { return await ingestOnce(pool); } finally { await pool.end(); }
}
// Uses the deployed Node process and the same PostgreSQL lock as the CLI; opt-in only.
export function startPeriodicIngestion(env = process.env, log: (report: unknown) => void = r => console.log(JSON.stringify(r)),
    run: () => Promise<IngestionReport> = () => ingestConfigured(env)) {
    if (env.COURSES_INGEST_ENABLED !== 'true') return async () => {};
    ingestionConfig(env);
    const hours = Number(env.COURSES_INGEST_INTERVAL_HOURS ?? 24);
    if (!Number.isInteger(hours) || hours < 6 || hours > 168) throw new IngestError('INVALID_INGEST_INTERVAL');
    let active: Promise<void> | null = null, stopped = false, notBefore = 0;
    const tick = () => {
        if (active || stopped || Date.now() < notBefore) return;
        active = run().then(report => {
            notBefore = Math.min(Number.MAX_SAFE_INTEGER,Date.now() + Math.max(0,...report.sources.map(s => 'error' in s ? s.retryAfterMs : 0)));
            log(report);
        }).catch(() => log({ event: 'COURSES_INGEST_FAILED' })).finally(() => { active = null; });
    };
    const timer = setInterval(tick,hours * 3600000); timer.unref(); tick();
    return async () => { stopped = true; clearInterval(timer); await active; };
}
