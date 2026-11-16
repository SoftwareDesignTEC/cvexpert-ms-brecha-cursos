import assert from 'node:assert/strict';
import { readFile, mkdtemp, writeFile, unlink, rmdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';
import { Pool } from 'pg';
import { migrate } from '../../src/db/migrate.js';
import { getDatabaseConfig } from '../../src/db/config.js';
import { withTestDatabase } from './helpers/test-database.js';
import { createPostgresStaging, disposableMarker } from '../../scripts/course-sync/postgres.js';
import { testCandidate, testRun } from '../fixtures/course-sync.test.js';
import type { SyncCandidate, SyncRun } from '../../scripts/course-sync/model.js';
import { runLocalSync } from '../../scripts/sync-courses-local.js';

test('Course Sync staging real PostgreSQL 17: transacciones, permisos y recuperación', async t => withTestDatabase(async owner => {
    assert.match((await owner.query('SHOW server_version')).rows[0].server_version,/^17\./);
    await migrate(owner);
    assert.deepEqual(await migrate(owner),[]);
    const database = String(owner.options.database);
    await owner.query(`COMMENT ON DATABASE "${database}" IS '${disposableMarker}'`);
    await owner.query(await readFile(new URL('../../db/course-sync-local-grants.sql',import.meta.url),'utf8'));
    await owner.query(`INSERT INTO course_sync.providers(source_id,authorization_state,authorization_reference)
        VALUES('TEST-provider','authorized','TEST-reviewed-only')`);
    const config = { ...getDatabaseConfig(), database, host: '127.0.0.1', ssl: false };
    const ingest = new Pool({ ...config,user: 'cvexpert_sync_ingest',password: 'TEST-sync-ingest-only' });
    const editor = new Pool({ ...config,user: 'cvexpert_sync_editor',password: 'TEST-sync-editor-only' });
    const http = new Pool({ ...config,user: 'cvexpert_brecha_app',password: process.env.PG_READONLY_PASSWORD });
    const store = createPostgresStaging(ingest);
    let tick = 0;
    const run = (patch: Partial<SyncRun> = {}, c: Partial<SyncCandidate> = {}) => {
        const time = new Date(Date.UTC(2026,10,15,12,0,++tick)).toISOString();
        const candidate = testCandidate({ ...c,lastSeenAt: time });
        candidate.evidence.forEach(e => e.queriedAt = time);
        return testRun({ runId: `TEST-run-${tick}`, observedAt: time,candidates: [candidate],...patch });
    };
    const row = async () => (await owner.query('SELECT * FROM course_sync.candidates ORDER BY candidate_id')).rows[0];
    const reset = async () => owner.query('TRUNCATE course_sync.observations,course_sync.checkpoints,course_sync.runs,course_sync.candidates');
    // Synthetic manual published fixture, only in the UUID disposable database.
    const publishedId = (await owner.query(`INSERT INTO public.courses(title,platform,url,is_paid)
        VALUES('[TEST] Manual publicado','[TEST] Manual','https://example.org/TEST/agriculture',false) RETURNING id`)).rows[0].id;
    const publicBefore = (await owner.query(`SELECT (SELECT jsonb_agg(c) FROM public.courses c) AS courses,
        (SELECT jsonb_agg(s) FROM public.skills s) AS skills,(SELECT jsonb_agg(cs) FROM public.course_skills cs) AS links`)).rows;
    try {
        await t.test('primera inserción, repetición idéntica y run ID inmutable', async () => {
            const input = run();
            assert.equal((await store.execute(input)).actions[0]?.kind,'insert');
            const before = await row();
            assert.equal((await store.execute(input)).replay,true);
            assert.deepEqual(await row(),before);
            assert.equal((await owner.query('SELECT count(*) FROM course_sync.observations')).rows[0].count,'1');
            assert.equal(before.published_course_id,null,'matching a public URL never grants ownership');
            await assert.rejects(store.execute({ ...input,status: 'partial' }),/RUN_ID_REUSED/);
            assert.equal((await store.load()).snapshot.courses.length,1);
        });
        await t.test('identidad estable cambia URL y título sin cambiar candidato ni vínculo', async () => {
            const before = await row();
            await store.execute(run({}, { canonicalUrl: 'https://example.org/TEST/new-url',title: '[TEST] Nuevo',durationMinutes: 90,language: 'es',isPaid: true }));
            const after = await row();
            assert.equal(after.candidate_id,before.candidate_id);
            assert.equal(after.canonical_url,'https://example.org/TEST/new-url');
            assert.equal(after.published_course_id,null);
            assert.equal(after.version,before.version + 1);
            await editor.query(`UPDATE course_sync.candidates SET published_course_id=$1,
                link_reviewed_by='TEST-editor',link_reviewed_at=clock_timestamp() WHERE candidate_id=$2`,[publishedId,after.candidate_id]);
        });
        await t.test('campo ausente conserva conocimiento y observación original registra null', async () => {
            await store.execute(run({}, { canonicalUrl: 'https://example.org/TEST/new-url',title: '[TEST] Nuevo' }));
            const after = await row();
            assert.equal(after.observed.durationMinutes,90);
            assert.equal(after.observed.language,'es'); assert.equal(after.observed.isPaid,true);
            assert.equal(after.published_course_id,publishedId);
            const raw = (await owner.query('SELECT document FROM course_sync.observations ORDER BY run_id')).rows;
            assert.ok(raw.some(r => r.document.durationMinutes === null));
        });
        await t.test('precio, ubicación y convocatorias retienen campos desconocidos sin aprobar habilidades', async () => {
            await reset();
            const location = { country: 'CR',region: 'TEST-region',locality: 'TEST-locality' };
            const offering = { externalId: 'TEST-call',availability: 'available' as const,
                startsAt: '2027-01-01T00:00:00.000Z',endsAt: '2027-02-01T00:00:00.000Z',modality: 'hybrid' as const,geography: location };
            await store.execute(run({}, { price: { amount: '25.00',currency: 'USD' },geography: location,offerings: [offering] }));
            await store.execute(run({}, { price: null, geography: { country: null,region: null,locality: null },
                offerings: [{ ...offering,startsAt: null,endsAt: null,geography: null }] }));
            const current = await row();
            assert.deepEqual(current.observed.price,{ amount: '25.00',currency: 'USD' });
            assert.deepEqual(current.observed.geography,location);
            assert.deepEqual(current.observed.offerings,[offering]);
            assert.equal(current.verified,null);
            const invalid = run({}, { price: { amount: '-1',currency: 'USD' } });
            assert.ok((await store.execute(invalid)).actions.some(a => a.kind === 'invalid'));
        });
        await t.test('duplicados, discrepancias y colisiones no escogen un ganador', async () => {
            await reset();
            const input = run(); input.candidates.push(structuredClone(input.candidates[0]));
            const result = await store.execute(input);
            assert.ok(result.actions.some(a => a.kind === 'duplicate'));
            assert.equal((await owner.query('SELECT count(*) FROM course_sync.candidates')).rows[0].count,'1');
            const before = await row();
            const conflicting = run(); conflicting.candidates.push({ ...(conflicting.candidates[0] as SyncCandidate),title: '[TEST] conflicto' });
            assert.ok((await store.execute(conflicting)).actions.some(a => a.kind === 'ambiguous'));
            assert.deepEqual(await row(),before);
            await editor.query(`INSERT INTO course_sync.providers(source_id,authorization_state,authorization_reference)
                VALUES('TEST-other-provider','authorized','TEST-reviewed')`);
            const other = run({ sourceId: 'TEST-other-provider' },{ sourceId: 'TEST-other-provider' });
            assert.ok((await store.execute(other)).actions.some(a => a.kind === 'ambiguous'));
            assert.deepEqual(await row(),before);
            assert.ok((await store.execute(run({}, { externalId: 'TEST-other' }))).actions.some(a => a.kind === 'ambiguous'));
            assert.deepEqual(await row(),before);
        });
        await t.test('fallback URL es controlado; cambio URL sin identidad no reclama el anterior', async () => {
            await reset();
            await store.execute(run({ scope: 'query' },{ externalId: null }));
            const id = (await row()).candidate_id;
            await store.execute(run({ scope: 'query' },{ externalId: null }));
            assert.equal((await row()).candidate_id,id);
            await store.execute(run({ scope: 'query' },{ externalId: null,canonicalUrl: 'https://example.org/TEST/other' }));
            assert.equal((await store.load()).snapshot.courses.length,2);
        });
        await t.test('conflicto editorial y versión obsoleta preservan datos verificados', async () => {
            await reset(); await store.execute(run());
            const old = await row();
            await editor.query(`UPDATE course_sync.candidates SET verified=observed,verified_by='TEST-editor',
                verified_at=clock_timestamp(),review_state='verified' WHERE candidate_id=$1`,[old.candidate_id]);
            const verified = await row();
            assert.equal(verified.version,old.version + 1);
            const stale = await store.execute(run(),{ [old.candidate_id]: old.version });
            assert.ok(stale.actions.some(a => a.reason === 'VERSION_CONFLICT'));
            const conflict = await store.execute(run({}, { title: '[TEST] Discrepancia editorial' }));
            assert.ok(conflict.actions.some(a => a.reason === 'EDITORIAL_CONFLICT'));
            assert.deepEqual(await row(),verified);
            await store.execute(run());
            assert.deepEqual((await row()).verified,verified.verified);
            await store.execute(run({ scope: 'query' },{ externalId: 'TEST-second',canonicalUrl: 'https://example.org/TEST/second' }));
            const unsafe = await store.execute(run({}, { title: '[TEST] Conflicto con otra fila ausente' }));
            assert.equal(unsafe.absenceEligible,false);
            assert.equal((await owner.query("SELECT missing_count FROM course_sync.candidates WHERE external_id='TEST-second'")).rows[0].missing_count,0);
        });
        await t.test('registros manuales protegidos y cursos públicos nunca se adoptan', async () => {
            await reset(); await store.execute(run());
            await owner.query("UPDATE course_sync.candidates SET origin='manual'").then(
                () => assert.fail('origin must be immutable'), e => assert.match(e.message,/IMMUTABLE_IDENTITY/));
            const d = testCandidate();
            await reset();
            await owner.query(`INSERT INTO course_sync.candidates(candidate_id,source_id,external_id,identity_key,canonical_url,title,
                origin,observed,last_valid_seen_at) VALUES($1,$2,$3,jsonb_build_array($2::text,'id',$3::text)::text,$4,$5,'manual',$6,$7)`,
            [randomUUID(),d.sourceId,d.externalId,d.canonicalUrl,d.title,JSON.stringify(d),d.lastSeenAt]);
            const before = await row();
            assert.ok((await store.execute(run({}, { title: '[TEST] no autorizado' }))).actions.some(a => a.kind === 'manual_protected'));
            assert.deepEqual(await row(),before);
        });
        await t.test('dos ejecuciones concurrentes confirman una sola vez y serializan snapshot', async () => {
            await reset();
            const input = run();
            const results = await Promise.all([store.execute(input),store.execute(input)]);
            assert.equal(results.filter(r => r.replay).length,1);
            const a = run(), b = run();
            await Promise.all([store.execute(a),store.execute(b)]);
            assert.equal((await owner.query('SELECT count(*) FROM course_sync.candidates')).rows[0].count,'1');
            assert.equal((await owner.query('SELECT run_id FROM course_sync.checkpoints')).rows[0].run_id,b.runId);
        });
        await t.test('fallo antes de COMMIT revierte candidato, auditoría y checkpoint; reintento recupera', async () => {
            await reset(); const input = run();
            await owner.query(`CREATE FUNCTION course_sync.test_fail_checkpoint() RETURNS trigger LANGUAGE plpgsql AS $$
                BEGIN RAISE EXCEPTION 'TEST_BEFORE_COMMIT'; END $$;
                CREATE TRIGGER test_fail BEFORE INSERT ON course_sync.checkpoints FOR EACH ROW EXECUTE FUNCTION course_sync.test_fail_checkpoint()`);
            try {
                await assert.rejects(store.execute(input),/TEST_BEFORE_COMMIT/);
                for (const table of ['candidates','observations','runs','checkpoints']) {
                    assert.equal((await owner.query(`SELECT count(*) FROM course_sync.${table}`)).rows[0].count,'0');
                }
            } finally { await owner.query('DROP TRIGGER test_fail ON course_sync.checkpoints; DROP FUNCTION course_sync.test_fail_checkpoint()'); }
            assert.equal((await store.execute(input)).replay,false);
            assert.equal((await store.execute(input)).replay,true);
            const cp = (await owner.query(`SELECT c.run_id,r.result FROM course_sync.checkpoints c
                JOIN course_sync.runs r USING(source_id,run_id)`)).rows[0];
            assert.equal(cp.run_id,input.runId); assert.equal(cp.result.skipped,false);
        });
        await t.test('respuesta COMMIT perdida se resuelve repitiendo el mismo run sin duplicar', async () => {
            await reset(); const input = run();
            const client = await ingest.connect();
            const query = client.query.bind(client);
            const connectMock = t.mock.method(ingest,'connect',async () => client);
            const queryMock = t.mock.method(client,'query',(async (...args: any[]) => {
                const result = await (query as any)(...args);
                if (args[0] === 'COMMIT') throw new Error('TEST_LOST_COMMIT_RESPONSE');
                return result;
            }) as any);
            try { await assert.rejects(store.execute(input),/COMMIT_UNCERTAIN_RETRY_SAME_RUN/); }
            finally { connectMock.mock.restore(); queryMock.mock.restore(); }
            assert.equal((await store.execute(input)).replay,true);
            assert.equal((await owner.query('SELECT count(*) FROM course_sync.candidates')).rows[0].count,'1');
        });
        await t.test('errores transitorios reintentan la transacción completa con límite y sin duplicados', async () => {
            await reset();
            await owner.query(`CREATE SEQUENCE course_sync.test_attempt;
                GRANT USAGE ON SEQUENCE course_sync.test_attempt TO cvexpert_sync_ingest;
                CREATE FUNCTION course_sync.test_retry() RETURNS trigger LANGUAGE plpgsql AS $$
                BEGIN IF nextval('course_sync.test_attempt') < 3 THEN
                    RAISE EXCEPTION 'TEST_SERIALIZATION' USING ERRCODE='40001'; END IF; RETURN NEW; END $$;
                CREATE TRIGGER test_retry BEFORE INSERT ON course_sync.checkpoints FOR EACH ROW EXECUTE FUNCTION course_sync.test_retry()`);
            try {
                await store.execute(run());
                assert.equal((await owner.query('SELECT last_value FROM course_sync.test_attempt')).rows[0].last_value,'3');
                assert.equal((await owner.query('SELECT count(*) FROM course_sync.runs')).rows[0].count,'1');
            } finally {
                await owner.query('DROP TRIGGER test_retry ON course_sync.checkpoints; DROP FUNCTION course_sync.test_retry(); DROP SEQUENCE course_sync.test_attempt');
            }
        });
        await t.test('aplicación local explícita con archivo, destino confirmado y replay durable', async () => {
            await reset();
            const directory = await mkdtemp(join(tmpdir(),'cvexpert-sync-local-'));
            const file = join(directory,'TEST-run.json');
            await writeFile(file,JSON.stringify(run()));
            const env = { NODE_ENV: 'test',COURSE_SYNC_HOST: '127.0.0.1',COURSE_SYNC_PORT: String(config.port),
                COURSE_SYNC_DATABASE: database,COURSE_SYNC_CONFIRM_DISPOSABLE: database,
                COURSE_SYNC_USER: 'cvexpert_sync_ingest',COURSE_SYNC_PASSWORD: 'TEST-sync-ingest-only' };
            try {
                assert.equal((await runLocalSync(['--apply-local',file],env)).replay,false);
                assert.equal((await runLocalSync(['--apply-local',file],env)).replay,true);
            } finally { await unlink(file); await rmdir(directory); }
        });
        await t.test('consultas, fallos y páginas incompletas no cuentan ausencias; tres completas proponen revisión', async () => {
            for (const patch of [{ scope: 'query' },{ status: 'partial' },{ status: 'failed' },{ valid: false },
                { missingPages: true },{ quotaLimited: true },{ errors: ['TEST-error'] }]) {
                const result = await store.execute(run({ ...patch,candidates: [] } as Partial<SyncRun>));
                assert.equal(result.absenceEligible,false); assert.equal((await row()).missing_count,0);
            }
            for (let n = 1; n <= 3; n++) {
                const result = await store.execute(run({ candidates: [] }));
                assert.equal((await row()).missing_count,n);
                assert.equal(result.actions[0]?.kind,n === 3 ? 'deactivation_candidate' : 'missing');
            }
        });
        await t.test('proveedor revocado, entorno sin marca y permisos reales denegados', async () => {
            await editor.query("UPDATE course_sync.providers SET authorization_state='revoked'");
            try { await assert.rejects(store.execute(run()),/PROVIDER_NOT_AUTHORIZED/); }
            finally { await editor.query("UPDATE course_sync.providers SET authorization_state='authorized'"); }
            await owner.query(`COMMENT ON DATABASE "${database}" IS NULL`);
            try { await assert.rejects(store.execute(run()),/UNVERIFIED_DISPOSABLE/); }
            finally { await owner.query(`COMMENT ON DATABASE "${database}" IS '${disposableMarker}'`); }
            await owner.query('GRANT UPDATE(verified) ON course_sync.candidates TO cvexpert_sync_ingest');
            try { await assert.rejects(store.execute(run()),/UNVERIFIED_DISPOSABLE/); }
            finally { await owner.query('REVOKE UPDATE(verified) ON course_sync.candidates FROM cvexpert_sync_ingest'); }
            for (const pool of [ingest,http]) {
                for (const sql of ["INSERT INTO public.courses(title,platform,url,is_paid) VALUES('TEST','TEST','https://example.org/TEST',false)",
                    'UPDATE public.courses SET title=title','DELETE FROM public.courses',"INSERT INTO public.skills(name) VALUES('TEST')",
                    'DELETE FROM public.course_skills',"UPDATE course_sync.candidates SET verified=observed",
                    "UPDATE course_sync.candidates SET published_course_id=1"]) {
                    await assert.rejects(pool.query(sql),(e: any) => e.code === '42501');
                }
            }
            await assert.rejects(ingest.query("UPDATE course_sync.providers SET authorization_state='authorized'"),(e: any) => e.code === '42501');
            await assert.rejects(editor.query("UPDATE course_sync.candidates SET observed=observed"),(e: any) => e.code === '42501');
            await assert.rejects(http.query('SELECT * FROM course_sync.candidates'),(e: any) => e.code === '42501');
        });
        await t.test('compatibilidad 001–005 y catálogo público intacto', async () => {
            assert.equal((await owner.query('SELECT count(*) FROM public.schema_migrations')).rows[0].count,'5');
            const after = (await owner.query(`SELECT (SELECT jsonb_agg(c) FROM public.courses c) AS courses,
                (SELECT jsonb_agg(s) FROM public.skills s) AS skills,(SELECT jsonb_agg(cs) FROM public.course_skills cs) AS links`)).rows;
            assert.deepEqual(after,publicBefore);
        });
        await t.test('constraints rechazan JSON inválido, aprobación sin editor y vínculo sin revisión', async () => {
            for (const value of [{ ...testCandidate(),availability: null },{ ...testCandidate(),evidence: [{}] },
                { ...testCandidate(),associatedSkills: [null] },{ ...testCandidate(),price: { amount: '-1',currency: 'USD' } }]) {
                assert.equal((await owner.query('SELECT course_sync.valid_document($1) AS valid',[JSON.stringify(value)])).rows[0].valid,false);
            }
            await assert.rejects(owner.query("UPDATE course_sync.candidates SET verified=observed,review_state='verified'"),
                (e: any) => e.code === '23514');
            await assert.rejects(owner.query('UPDATE course_sync.candidates SET published_course_id=2147483647'),
                (e: any) => ['23514','23503'].includes(e.code));
        });
    } finally { await Promise.all([ingest.end(),editor.end(),http.end()]); }
}));
