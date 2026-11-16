import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile, mkdtemp, writeFile, unlink, rmdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { Pool } from 'pg';
import { migrate } from '../../src/db/migrate.js';
import { getDatabaseConfig } from '../../src/db/config.js';
import { withTestDatabase } from './helpers/test-database.js';
import { createPostgresStaging, disposableMarker } from '../../scripts/course-sync/postgres.js';
import { OpenLearnProvider } from '../../scripts/course-discovery/openlearn-provider.js';
import { discoverOpenLearn, ingestOpenLearn } from '../../scripts/course-sync/openlearn-integration.js';
import { runOpenLearnIntegration } from '../../scripts/integrate-openlearn-local.js';
import { testBinding, testSparql, openLearnFixture, openLearnTestTime } from '../fixtures/openlearn.test.js';
import type { SyncCandidate } from '../../scripts/course-sync/model.js';

test('OpenLearn → validación → Course Sync → PostgreSQL 17 staging: extremo a extremo sin red externa', async t => withTestDatabase(async owner => {
    t.mock.method(globalThis,'fetch',async () => { throw new Error('EXTERNAL_NETWORK_FORBIDDEN'); });
    assert.match((await owner.query('SHOW server_version')).rows[0].server_version,/^17\./);
    await migrate(owner);
    const database = String(owner.options.database);
    await owner.query(`COMMENT ON DATABASE "${database}" IS '${disposableMarker}'`);
    await owner.query(await readFile(new URL('../../db/course-sync-local-grants.sql',import.meta.url),'utf8'));
    await owner.query(`INSERT INTO course_sync.providers(source_id,authorization_state,authorization_reference)
        VALUES('openlearn','authorized','TEST-fixture-approval-only')`);
    const config = { ...getDatabaseConfig(),database,host: '127.0.0.1',ssl: false };
    const writer = new Pool({ ...config,user: 'cvexpert_sync_ingest',password: 'TEST-sync-ingest-only' });
    const editor = new Pool({ ...config,user: 'cvexpert_sync_editor',password: 'TEST-sync-editor-only' });
    const staging = createPostgresStaging(writer);
    const env = { NODE_ENV: 'test',COURSE_SYNC_HOST: '127.0.0.1',COURSE_SYNC_PORT: String(config.port),
        COURSE_SYNC_DATABASE: database,COURSE_SYNC_CONFIRM_DISPOSABLE: database,
        COURSE_SYNC_USER: 'cvexpert_sync_ingest',COURSE_SYNC_PASSWORD: 'TEST-sync-ingest-only' };
    const counts = async () => (await owner.query(`SELECT (SELECT count(*) FROM course_sync.candidates) AS candidates,
        (SELECT count(*) FROM course_sync.observations) AS observations,(SELECT count(*) FROM course_sync.runs) AS runs,
        (SELECT jsonb_agg(c) FROM course_sync.checkpoints c) AS checkpoints`)).rows[0];
    const rows = async () => (await owner.query('SELECT * FROM course_sync.candidates ORDER BY external_id')).rows;
    const catalog = async () => (await owner.query(`SELECT (SELECT jsonb_agg(c) FROM public.courses c) AS courses,
        (SELECT jsonb_agg(s) FROM public.skills s) AS skills,(SELECT jsonb_agg(cs) FROM public.course_skills cs) AS links`)).rows;
    // A synthetic manual catalog fixture in this UUID disposable DB, never an operational course.
    await owner.query(`INSERT INTO public.courses(title,platform,url,is_paid) VALUES('[TEST] manual','TEST','https://example.org/TEST/manual',false)`);
    const publicBefore = await catalog();
    let sequence = 0, requests = 0;
    const discover = (body: unknown = testSparql([testBinding()]),request?: typeof fetch) => {
        const at = new Date(Date.parse(openLearnTestTime) + ++sequence * 1000).toISOString();
        return discoverOpenLearn(new OpenLearnProvider({ timeoutMs: 20 },request ?? (async () => {
            requests++; return new Response(JSON.stringify(body),{ headers: { 'content-type': 'application/sparql-results+json' } });
        }),() => Date.parse(at)),{ runId: `TEST-openlearn-${sequence}`,observedAt: at });
    };
    try {
        const first = await discover(openLearnFixture());
        await t.test('primera ingesta guarda candidatos, evidencia, rechazo, duplicado y checkpoint', async () => {
            assert.equal((await counts()).candidates,'0');
            const directory = await mkdtemp(join(tmpdir(),'cvexpert-openlearn-first-')),file = join(directory,'TEST-run.json');
            await writeFile(file,JSON.stringify(first));
            let report;
            try { report = await runOpenLearnIntegration(['--apply-local',file],env); }
            finally { await unlink(file); await rmdir(directory); }
            assert.deepEqual(report.counts,{ inserts: 5,updates: 0,unchanged: 0,duplicates: 1,rejected: 2,conflicts: 0 });
            assert.equal(report.result.absenceEligible,false);
            assert.equal(report.status,'partial'); assert.equal(report.history[0]?.scope,'query');
            assert.ok(report.history[0]?.coverage.errors.some(e => e.startsWith('REJECTED_RECORD:')));
            const state = await counts();
            assert.equal(state.candidates,'5'); assert.equal(state.observations,'6'); assert.equal(state.runs,'1');
            assert.equal(state.checkpoints[0].run_id,first.run.runId);
            const current = await rows();
            for (const r of current) {
                assert.equal(r.review_state,'pending'); assert.equal(r.verified,null); assert.equal(r.published_course_id,null);
                assert.deepEqual(r.observed.associatedSkills,[]); assert.equal(r.observed.durationMinutes,null);
                assert.equal(r.observed.evidence[0].responseSha256,createHash('sha256').update(JSON.stringify(openLearnFixture())).digest('hex'));
            }
        });
        await t.test('repetición del mismo run y CLI no repiten descubrimiento ni DML; historial recuperable', async () => {
            const before = await counts(), candidates = await rows(), calls = requests;
            const report = await ingestOpenLearn(first,staging);
            assert.equal(report.result.replay,true);
            assert.deepEqual(await counts(),before); assert.deepEqual(await rows(),candidates); assert.equal(requests,calls);
            const directory = await mkdtemp(join(tmpdir(),'cvexpert-openlearn-cli-')),file = join(directory,'TEST-run.json');
            await writeFile(file,JSON.stringify(first));
            try {
                const applied = await runOpenLearnIntegration(['--apply-local',file],env);
                assert.equal(applied.result.replay,true);
                const history = await runOpenLearnIntegration(['--history-local'],env);
                assert.equal(history.history[0].runId,first.run.runId);
            } finally { await unlink(file); await rmdir(directory); }
            assert.equal((await staging.history('openlearn',1)).length,1);
            await assert.rejects(staging.history('openlearn',101),/INVALID_HISTORY_LIMIT/);
        });
        await t.test('nueva observación cambia título y URL con identidad estable; desconocidos conservan conocimiento', async () => {
            const original = (await rows())[0];
            // Explicit synthetic prior knowledge; the current RDF adapter never invents duration/language.
            await owner.query(`UPDATE course_sync.candidates SET observed=jsonb_set(jsonb_set(observed,'{durationMinutes}','90'),
                '{language}','"es"') WHERE candidate_id=$1`,[original.candidate_id]);
            const changed = { ...testBinding(),title: { type: 'literal',value: '[TEST] Updated source title' },
                url: { type: 'uri',value: 'https://www.open.edu/openlearn/test-updated/content-section-0' } };
            const prepared = await discover(testSparql([changed]));
            const report = await ingestOpenLearn(prepared,staging);
            assert.equal(report.counts.updates,1); assert.equal(report.result.absenceEligible,false);
            const current = (await rows())[0];
            assert.equal(current.candidate_id,original.candidate_id); assert.equal(current.title,'[TEST] Updated source title');
            assert.equal(current.observed.durationMinutes,90); assert.equal(current.observed.language,'es');
            assert.equal((prepared.run.candidates[0] as SyncCandidate).durationMinutes,null);
            assert.equal((await owner.query('SELECT document FROM course_sync.observations WHERE run_id=$1',[prepared.run.runId])).rows[0].document.durationMinutes,null);
        });
        await t.test('duplicados contradictorios y revisión editorial preservada, sin habilidades automáticas', async () => {
            const original = (await rows())[0];
            await editor.query(`UPDATE course_sync.candidates SET verified=jsonb_set(jsonb_set(observed,'{associatedSkills}','["SQL"]'),
                '{durationMinutes}','120'),verified_by='TEST-editor',verified_at=clock_timestamp(),review_state='verified' WHERE candidate_id=$1`,[original.candidate_id]);
            const reviewed = (await rows())[0];
            const unchanged = { ...testBinding(),title: { type: 'literal',value: original.title },url: { type: 'uri',value: original.canonical_url } };
            assert.equal((await ingestOpenLearn(await discover(testSparql([unchanged])),staging)).counts.conflicts,0);
            assert.deepEqual((await rows())[0].verified,reviewed.verified);
            const conflict = { ...unchanged,title: { type: 'literal',value: '[TEST] Conflicting source title' } };
            const report = await ingestOpenLearn(await discover(testSparql([conflict])),staging);
            assert.ok(report.result.actions.some(a => a.reason === 'EDITORIAL_CONFLICT'));
            const duplicate = await ingestOpenLearn(await discover(testSparql([unchanged,conflict])),staging);
            assert.equal(duplicate.counts.conflicts,1);
            const current = (await rows())[0];
            assert.deepEqual(current.verified,reviewed.verified); assert.deepEqual(current.observed.associatedSkills,[]);
            assert.equal((await rows())[1].review_state,'pending');
        });
        await t.test('429, timeout y JSON inválido tienen recibo fallido, sin observaciones falsas ni bajas', async () => {
            for (const [code,request] of [
                ['RATE_LIMITED',async () => new Response('TEST-secret',{ status: 429 })],
                ['TIMEOUT',async () => new Promise<Response>(() => {})],
                ['INVALID_SPARQL_RESPONSE',async () => new Response('{',{ headers: { 'content-type': 'application/sparql-results+json' } })],
            ] as const) {
                const before = await counts(), candidates = await rows();
                const p = await discover(null,request), report = await ingestOpenLearn(p,staging);
                assert.equal(report.status,'failed'); assert.deepEqual(p.run.errors,[code]); assert.equal(report.result.absenceEligible,false);
                assert.deepEqual(await rows(),candidates); assert.equal((await counts()).observations,before.observations);
                assert.equal((await staging.history('openlearn',1))[0]?.status,'failed');
                assert.equal((await counts()).checkpoints[0].run_id,p.run.runId);
            }
        });
        await t.test('fallo transaccional conserva archivo/run para reintento sin otra petición', async () => {
            const p = await discover(),before = await counts(),candidates = await rows(),calls = requests;
            const directory = await mkdtemp(join(tmpdir(),'cvexpert-openlearn-retry-')),file = join(directory,'TEST-run.json');
            const original = JSON.stringify(p); await writeFile(file,original);
            try {
                await owner.query(`CREATE FUNCTION course_sync.test_integration_fail() RETURNS trigger LANGUAGE plpgsql AS $$
                    BEGIN RAISE EXCEPTION 'TEST_INTEGRATION_ROLLBACK'; END $$;
                    CREATE TRIGGER test_integration_fail BEFORE UPDATE ON course_sync.checkpoints FOR EACH ROW EXECUTE FUNCTION course_sync.test_integration_fail()`);
                try {
                    await assert.rejects(runOpenLearnIntegration(['--apply-local',file],env),/TEST_INTEGRATION_ROLLBACK/);
                    assert.deepEqual(await counts(),before); assert.deepEqual(await rows(),candidates);
                    assert.equal(await readFile(file,'utf8'),original);
                } finally { await owner.query('DROP TRIGGER test_integration_fail ON course_sync.checkpoints; DROP FUNCTION course_sync.test_integration_fail()'); }
                const retry = await runOpenLearnIntegration(['--apply-local',file],env);
                assert.equal(retry.result.replay,false);
                assert.equal((await runOpenLearnIntegration(['--apply-local',file],env)).result.replay,true);
                assert.equal(requests,calls);
            } finally { await unlink(file); await rmdir(directory); }
        });
        await t.test('fuente revocada y permisos peligrosos bloquean ingesta; catálogo público intacto', async () => {
            const p = await discover(),before = await counts();
            await editor.query("UPDATE course_sync.providers SET authorization_state='revoked' WHERE source_id='openlearn'");
            await assert.rejects(ingestOpenLearn(p,staging),/PROVIDER_NOT_AUTHORIZED/);
            assert.deepEqual(await counts(),before);
            for (const sql of ['UPDATE public.courses SET title=title','DELETE FROM public.skills','DELETE FROM public.course_skills']) {
                await assert.rejects(writer.query(sql),(e: any) => e.code === '42501');
            }
            assert.deepEqual(await catalog(),publicBefore);
            assert.ok((await rows()).every(r => r.missing_count === 0 && r.published_course_id === null));
        });
    } finally { await writer.end(); await editor.end(); }
}));
