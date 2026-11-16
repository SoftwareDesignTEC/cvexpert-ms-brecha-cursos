import { createHash, randomUUID } from 'node:crypto';
import type { Pool, PoolClient } from 'pg';
import { text } from '../course-discovery/model.js';
import type { Snapshot, SyncCandidate, SyncRun } from './model.js';
import type { CourseSyncStaging, StagingResult, StagingSnapshot } from './persistence.js';
import { reconcile } from './reconcile.js';
import { identity, normalize, timestamp } from './validation.js';

export const disposableMarker = 'cvexpert-course-sync-disposable-v1';
function canonical(value: unknown): string {
    if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
    if (value !== null && typeof value === 'object') return `{${Object.entries(value)
        .filter(([,v]) => v !== undefined).sort(([a],[b]) => a < b ? -1 : a > b ? 1 : 0)
        .map(([k,v]) => `${JSON.stringify(k)}:${canonical(v)}`).join(',')}}`;
    return JSON.stringify(value ?? null);
}
export function assertLocalTarget(options: { host?: string; database?: string; user?: string }) {
    if (!['127.0.0.1', '::1'].includes(options.host ?? '')
        || !/^cvexpert_test_[a-f0-9]{32}$/.test(options.database ?? '')
        || options.user !== 'cvexpert_sync_ingest') throw new Error('LOCAL_DISPOSABLE_INGEST_ONLY');
}
async function verify(client: PoolClient) {
    // Docker port forwarding exposes a bridge address on the server. Verify the
    // actual client TCP peer, not inet_server_addr(), which is inside the container.
    const peer = (client as PoolClient & { connection: { stream: { remoteAddress?: string } } }).connection.stream.remoteAddress;
    const { rows: [s] } = await client.query(`SELECT current_database() AS db, current_user AS role,
        inet_server_addr()::text AS address, current_setting('server_version_num')::integer AS version,
        shobj_description((SELECT oid FROM pg_database WHERE datname=current_database()), 'pg_database') AS marker,
        (SELECT rolsuper OR rolcreaterole OR rolcreatedb OR rolbypassrls FROM pg_roles WHERE rolname=current_user) AS elevated,
        (SELECT bool_or(has_table_privilege(current_user,c.oid,'INSERT,UPDATE,DELETE,TRUNCATE,TRIGGER,REFERENCES')
            OR has_any_column_privilege(current_user,c.oid,'INSERT,UPDATE,REFERENCES'))
         FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
         WHERE n.nspname='public' AND c.relkind IN ('r','p')) AS public_write,
        has_schema_privilege(current_user,'public','CREATE') AS public_create,
        has_schema_privilege(current_user,'course_sync','CREATE') AS staging_create,
        (SELECT bool_or(has_column_privilege(current_user,'course_sync.candidates',c,'INSERT,UPDATE'))
            FROM unnest(ARRAY['origin','verified','verified_by','verified_at','review_state','published_course_id',
                'link_reviewed_by','link_reviewed_at','version']) c) AS editorial_write,
        has_any_column_privilege(current_user,'course_sync.providers','INSERT,UPDATE') AS authorization_write,
        (SELECT bool_or(has_table_privilege(current_user,t,'DELETE,TRUNCATE,TRIGGER,REFERENCES'))
            FROM unnest(ARRAY['course_sync.candidates','course_sync.providers','course_sync.runs',
                'course_sync.observations','course_sync.checkpoints']) t) AS staging_destructive,
        has_any_column_privilege(current_user,'course_sync.runs','UPDATE')
            OR has_any_column_privilege(current_user,'course_sync.observations','UPDATE') AS audit_update,
        has_function_privilege(current_user,'public.lock_admin_import_tables()','EXECUTE') AS admin_lock`);
    if (!s || s.role !== 'cvexpert_sync_ingest' || !/^cvexpert_test_[a-f0-9]{32}$/.test(s.db)
        || !['127.0.0.1','::1','::ffff:127.0.0.1'].includes(peer ?? '') || s.version < 170000 || s.version >= 180000
        || s.marker !== disposableMarker || s.elevated || s.public_write || s.public_create || s.admin_lock
        || s.staging_create || s.editorial_write || s.authorization_write || s.staging_destructive || s.audit_update) {
        throw new Error('UNVERIFIED_DISPOSABLE_SESSION');
    }
}
interface Row {
    candidate_id: string; observed: SyncCandidate; verified: SyncCandidate | null; version: number;
    origin: 'sync' | 'manual'; missing_count: number; review_state: string;
}
async function readSnapshot(client: PoolClient, lock = false): Promise<StagingSnapshot & { rows: Row[] }> {
    const { rows } = await client.query<Row>(`SELECT candidate_id, observed, verified, version, origin, missing_count, review_state
        FROM course_sync.candidates ORDER BY candidate_id ${lock ? 'FOR UPDATE' : ''}`);
    const cp = await client.query('SELECT source_id,run_id,observed_at FROM course_sync.checkpoints');
    const snapshot: Snapshot = { courses: rows.map(r => ({ internalId: r.candidate_id, origin: r.origin,
        course: normalize(r.observed, r.observed.sourceId, r.observed.lastSeenAt), missingCount: r.missing_count,
        publication: 'draft' })), checkpoints: Object.fromEntries(cp.rows.map(r =>
        [r.source_id, { runId: r.run_id, observedAt: r.observed_at.toISOString() }])) };
    for (const r of rows) if (r.verified) normalize(r.verified, r.observed.sourceId, r.verified.lastSeenAt);
    return { snapshot, versions: Object.fromEntries(rows.map(r => [r.candidate_id, r.version])), rows };
}
// Unknown values cannot erase knowledge. Evidence remains the new raw evidence;
// the observations table preserves precisely what was (and was not) reported.
function retainKnown(previous: SyncCandidate, incoming: SyncCandidate): SyncCandidate {
    const c = structuredClone(incoming);
    for (const key of ['language','durationMinutes','isPaid','geography'] as const) {
        if (c[key] === null) Object.assign(c, { [key]: previous[key] });
    }
    if (c.geography && previous.geography) for (const key of ['country','region','locality'] as const) {
        c.geography[key] ??= previous.geography[key];
    }
    if (c.modality === 'unknown') c.modality = previous.modality;
    if (c.availability === 'unknown') c.availability = previous.availability;
    if (c.price == null && previous.price !== undefined) c.price = previous.price;
    if (!c.associatedSkills.length) c.associatedSkills = previous.associatedSkills;
    c.offerings = c.offerings.map(o => {
        const old = previous.offerings.find(p => p.externalId === o.externalId);
        if (!old) return o;
        return { ...o, startsAt: o.startsAt ?? old.startsAt, endsAt: o.endsAt ?? old.endsAt,
            geography: o.geography === null ? old.geography : { country: o.geography.country ?? old.geography?.country ?? null,
                region: o.geography.region ?? old.geography?.region ?? null, locality: o.geography.locality ?? old.geography?.locality ?? null },
            modality: o.modality === 'unknown' ? old.modality : o.modality,
            availability: o.availability === 'unknown' ? old.availability : o.availability };
    });
    return c;
}
function changedContradiction(previous: unknown, incoming: unknown, verified: unknown): boolean {
    const known = (v: unknown) => v != null && v !== 'unknown' && (!Array.isArray(v) || v.length > 0);
    if (!known(incoming) || !known(verified)) return false;
    if (typeof incoming === 'object' && !Array.isArray(incoming)
        && typeof verified === 'object' && !Array.isArray(verified)) {
        const before = previous as Record<string,unknown> | null | undefined;
        const reviewed = verified as Record<string,unknown>;
        return Object.entries(incoming as Record<string,unknown>)
            .some(([key,value]) => changedContradiction(before?.[key],value,reviewed[key]));
    }
    return canonical(previous) !== canonical(incoming) && canonical(verified) !== canonical(incoming);
}
function editorialConflict(verified: SyncCandidate, previous: SyncCandidate, incoming: SyncCandidate): boolean {
    // Compare source deltas before retainKnown: editorial enrichment and unchanged
    // source values are not contradictions. Unknown leaves never assert a change.
    for (const key of ['title','platform','canonicalUrl','language','durationMinutes','isPaid','modality','geography',
        'availability','associatedSkills','price'] as const) {
        if (changedContradiction(previous[key],incoming[key],verified[key])) return true;
    }
    // Missing offerings are not removals; compare explicit fields by stable offering ID.
    return incoming.offerings.some(o => changedContradiction(
        previous.offerings.find(p => p.externalId === o.externalId),o,
        verified.offerings.find(v => v.externalId === o.externalId)));
}
function validateRun(run: SyncRun) {
    text(run.runId); text(run.sourceId); timestamp(run.observedAt);
    if (!['full_catalog','query'].includes(run.scope) || !['complete','partial','failed'].includes(run.status)
        || ![run.valid,run.missingPages,run.quotaLimited].every(v => typeof v === 'boolean')
        || !Array.isArray(run.errors) || !Array.isArray(run.candidates)) throw new Error('INVALID_RUN');
    run.errors.forEach(e => text(e));
}
export function createPostgresStaging(pool: Pool): CourseSyncStaging {
    assertLocalTarget(pool.options);
    return {
        async load() {
            const c = await pool.connect();
            try {
                await c.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY'); await verify(c);
                const { snapshot, versions } = await readSnapshot(c);
                await c.query('COMMIT'); return { snapshot, versions };
            } catch (e) { await c.query('ROLLBACK'); throw e; } finally { c.release(); }
        },
        async execute(value, expectedVersions = {}) {
            const run = structuredClone(value); validateRun(run);
            const hash = createHash('sha256').update(canonical({ run, expectedVersions })).digest('hex');
            // Only transient transaction failures are retried. Reuse the same run ID after
            // connection/COMMIT uncertainty; the immutable run ledger resolves the outcome.
            for (let attempt = 0; ; attempt++) {
                const c = await pool.connect(); let committing = false, broken = false;
                try {
                    await c.query('BEGIN'); await c.query("SET LOCAL lock_timeout='5s'"); await verify(c);
                    // Global staging lock covers URL collisions across providers too.
                    await c.query('SELECT pg_advisory_xact_lock(834921, 5)');
                    const prior = (await c.query('SELECT input_sha256,result FROM course_sync.runs WHERE source_id=$1 AND run_id=$2',
                        [run.sourceId,run.runId])).rows[0];
                    if (prior) {
                        if (prior.input_sha256 !== hash) throw new Error('RUN_ID_REUSED_WITH_DIFFERENT_INPUT');
                        await c.query('ROLLBACK'); return { ...prior.result, replay: true } as StagingResult;
                    }
                    const provider = (await c.query('SELECT authorization_state FROM course_sync.providers WHERE source_id=$1', [run.sourceId])).rows[0];
                    if (provider?.authorization_state !== 'authorized') throw new Error('PROVIDER_NOT_AUTHORIZED');
                    const state = await readSnapshot(c, true);
                    const plan = reconcile(state.snapshot, run);
                    // Merge only after reconcile detects raw duplicates/collisions. Unknown
                    // preservation must never hide conflicting observations from that engine.
                    const accepted = new Set(plan.actions.filter(a => ['insert','update','unchanged','withdrawn'].includes(a.kind)).map(a => a.identity));
                    const result: StagingResult = { replay: false, skipped: plan.skipped, actions: plan.actions,
                        absenceEligible: plan.absenceEligible, massWithdrawalBlocked: plan.massWithdrawalBlocked };
                    const conflicts = new Map<string,string>();
                    for (const next of plan.next.courses) {
                        const old = state.rows.find(r => r.candidate_id === next.internalId);
                        if (!old || next.origin === 'manual' || next.course.sourceId !== run.sourceId || plan.skipped) continue;
                        const seen = accepted.has(identity(next.course));
                        if (!seen && old.missing_count === next.missingCount) continue;
                        if (Object.hasOwn(expectedVersions,old.candidate_id) && expectedVersions[old.candidate_id] !== old.version) {
                            conflicts.set(old.candidate_id,'VERSION_CONFLICT');
                        } else if (seen && old.verified && editorialConflict(old.verified,old.observed,next.course)) {
                            conflicts.set(old.candidate_id,'EDITORIAL_CONFLICT');
                        }
                        next.course = retainKnown(old.observed,next.course);
                    }
                    if (conflicts.size) {
                        result.absenceEligible = false;
                        result.actions = result.actions.filter(a => !['missing','deactivation_candidate'].includes(a.kind));
                    }
                    for (const next of plan.next.courses) {
                        const old = state.rows.find(r => r.candidate_id === next.internalId);
                        if (next.course.sourceId !== run.sourceId || next.origin === 'manual' || plan.skipped) continue;
                        const key = identity(next.course);
                        const seen = accepted.has(key);
                        const conflictReason = old && conflicts.get(old.candidate_id);
                        if (old && conflictReason) {
                            const conflict = { identity: key, internalId: old.candidate_id, kind: 'ambiguous' as const,
                                decision: 'human_review' as const, reason: conflictReason };
                            const action = result.actions.findIndex(a => a.identity === key && a.kind !== 'duplicate');
                            if (action >= 0) result.actions[action] = conflict; else result.actions.push(conflict);
                            continue;
                        }
                        if (!seen && (conflicts.size || old?.missing_count === next.missingCount)) continue;
                        if (old) {
                            const saved = await c.query(`UPDATE course_sync.candidates SET observed=$1,title=$2,canonical_url=$3,
                                last_valid_seen_at=$4,missing_count=$5 WHERE candidate_id=$6 AND version=$7 AND origin='sync'`,
                            [JSON.stringify(next.course),next.course.title,next.course.canonicalUrl,next.course.lastSeenAt,
                                next.missingCount,old.candidate_id,old.version]);
                            if (saved.rowCount !== 1) throw new Error('CONCURRENT_STAGING_CHANGE');
                        } else {
                            await c.query(`INSERT INTO course_sync.candidates(candidate_id,source_id,external_id,identity_key,
                                canonical_url,title,observed,last_valid_seen_at) VALUES($1,$2,$3,$4::jsonb::text,$5,$6,$7,$8)`,
                            [randomUUID(),run.sourceId,next.course.externalId,key,next.course.canonicalUrl,next.course.title,
                                JSON.stringify(next.course),next.course.lastSeenAt]);
                        }
                    }
                    await c.query(`INSERT INTO course_sync.runs(source_id,run_id,input_sha256,observed_at,scope,status,result,coverage)
                        VALUES($1,$2,$3,$4,$5,$6,$7,$8)`,[run.sourceId,run.runId,hash,run.observedAt,run.scope,run.status,JSON.stringify(result),
                        JSON.stringify({ valid: run.valid,missingPages: run.missingPages,quotaLimited: run.quotaLimited,errors: run.errors })]);
                    for (const [index,raw] of run.candidates.entries()) {
                        let candidate: SyncCandidate;
                        try { candidate = normalize(raw,run.sourceId,run.observedAt); } catch { continue; }
                        await c.query(`INSERT INTO course_sync.observations(source_id,run_id,ordinal,identity_key,document)
                            VALUES($1,$2,$3,$4::jsonb::text,$5)`,[run.sourceId,run.runId,index,identity(candidate),JSON.stringify(candidate)]);
                    }
                    if (!plan.skipped) await c.query(`INSERT INTO course_sync.checkpoints(source_id,run_id,observed_at) VALUES($1,$2,$3)
                        ON CONFLICT(source_id) DO UPDATE SET run_id=excluded.run_id,observed_at=excluded.observed_at`,
                    [run.sourceId,run.runId,run.observedAt]);
                    committing = true; await c.query('COMMIT'); return result;
                } catch (e) {
                    await c.query('ROLLBACK').catch(() => { broken = true; });
                    if (committing) { broken = true; throw new Error('COMMIT_UNCERTAIN_RETRY_SAME_RUN', { cause: e }); }
                    if (attempt < 2 && ['40001','40P01','55P03'].includes((e as { code?: string }).code ?? '')) continue;
                    throw e;
                } finally { c.release(broken); }
            }
        },
    };
}
