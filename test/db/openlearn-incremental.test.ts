import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readFile, mkdtemp, rm } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { Pool } from 'pg';
import { withTestDatabase } from './helpers/test-database.js';
import { migrate } from '../../src/db/migrate.js';
import { getDatabaseConfig } from '../../src/db/config.js';
import { createPostgresStaging, disposableMarker } from '../../scripts/course-sync/postgres.js';
import { fixtureTransport } from '../../scripts/openlearn-incremental/fixture.js';
import { initialize, fetchPage, applyPage, status } from '../../scripts/openlearn-incremental/session.js';
import { preparePage } from '../../scripts/openlearn-incremental/provider.js';

test('incremental OpenLearn → artifacts → PostgreSQL 17: pages, recovery, identities and editorial isolation', async t => withTestDatabase(async owner => {
    t.mock.method(globalThis,'fetch',async () => { throw Error('EXTERNAL_NETWORK_FORBIDDEN'); });
    assert.match((await owner.query('SHOW server_version')).rows[0].server_version,/^17\./);
    await migrate(owner); const database = String(owner.options.database);
    await owner.query(`COMMENT ON DATABASE "${database}" IS '${disposableMarker}'`);
    await owner.query(await readFile(new URL('../../db/course-sync-local-grants.sql',import.meta.url),'utf8'));
    await owner.query(`INSERT INTO course_sync.providers(source_id,authorization_state,authorization_reference)
        VALUES('openlearn','authorized','TEST-incremental-synthetic-only')`);
    await owner.query(`INSERT INTO public.courses(title,platform,url,is_paid) VALUES('[TEST] manual','TEST','https://example.org/TEST/manual',false)`);
    const publicRows = async () => (await owner.query(`SELECT (SELECT jsonb_agg(c) FROM public.courses c) AS courses,
        (SELECT jsonb_agg(s) FROM public.skills s) AS skills,(SELECT jsonb_agg(cs) FROM public.course_skills cs) AS links`)).rows;
    const beforePublic = await publicRows();
    const config = { ...getDatabaseConfig(),database,host: '127.0.0.1',ssl: false };
    const writer = new Pool({ ...config,user: 'cvexpert_sync_ingest',password: 'TEST-sync-ingest-only' });
    const editor = new Pool({ ...config,user: 'cvexpert_sync_editor',password: 'TEST-sync-editor-only' });
    const staging = createPostgresStaging(writer), target = `127.0.0.1:${config.port}:${database}:cvexpert_sync_ingest`;
    const root = await mkdtemp(join(tmpdir(),'cvexpert-incremental-db-'));
    let clock = Date.parse('2026-11-16T00:00:00.000Z'), calls = 0;
    const transport = fixtureTransport();
    const deps = { request: (async (...args) => { calls++; return transport(...args); }) as typeof fetch,
        editorialUrls: new Set<string>(),now: () => clock,sleep: async (ms: number) => { clock += ms; } };
    const counts = async () => (await owner.query(`SELECT (SELECT count(*) FROM course_sync.candidates) AS candidates,
        (SELECT count(*) FROM course_sync.observations) AS observations,(SELECT count(*) FROM course_sync.runs) AS runs,
        (SELECT run_id FROM course_sync.checkpoints WHERE source_id='openlearn') AS checkpoint`)).rows[0];
    const rows = async () => (await owner.query('SELECT * FROM course_sync.candidates ORDER BY external_id')).rows;
    try {
        await initialize(root,'fixture',null,null,{ pageSize: 10,maxPages: 2,maxRequests: 4,minIntervalMs: 2000 });
        const first = await fetchPage(root,'fixture',null,deps);
        await t.test('A/D: first page persists every category observation and atomic checkpoint',async () => {
            const report = await applyPage(root,'fixture',staging,target);
            assert.equal(report.result.actions.filter(a => a.kind === 'insert').length,10);
            assert.equal(report.result.absenceEligible,false);
            const c = await counts(); assert.equal(c.candidates,'10'); assert.equal(c.observations,'11'); assert.equal(c.runs,'1'); assert.equal(c.checkpoint,first.run.runId);
            assert.equal((await status(root,'fixture')).confirmedCursor,first.cursorNext);
            const current = await rows(); assert.equal(current[0].observed.evidence.length,2);
            assert.deepEqual(current[0].observed.evidence.map((e: any) => e.subjects[0]).sort(),['[TEST] Category A','[TEST] Category B']);
            const original = (await owner.query('SELECT document FROM course_sync.observations WHERE run_id=$1',[first.run.runId])).rows;
            assert.ok(original.every(r => r.document.durationMinutes === null && r.document.associatedSkills.length === 0));
            assert.ok((await staging.history('openlearn'))[0]?.coverage.missingPages);
            const before = await counts(); assert.equal((await staging.execute(first.run)).replay,true); assert.deepEqual(await counts(),before);
        });
        const initial = (await rows())[0];
        const publishedId = (await owner.query('SELECT id FROM public.courses LIMIT 1')).rows[0].id;
        await owner.query(`UPDATE course_sync.candidates SET observed=jsonb_set(observed,'{durationMinutes}','90') WHERE candidate_id=$1`,[initial.candidate_id]);
        await editor.query(`UPDATE course_sync.candidates SET verified=jsonb_set(jsonb_set(observed,'{associatedSkills}','["SQL"]'),'{durationMinutes}','120'),
            verified_by='TEST-only',verified_at=clock_timestamp(),review_state='verified',published_course_id=$2,
            link_reviewed_by='TEST-only',link_reviewed_at=clock_timestamp() WHERE candidate_id=$1`,[initial.candidate_id,publishedId]);
        const reviewed = (await rows())[0];
        // A second RDF resource reuses the same provider ID and same metadata: preserve identity, retain the evidence.
        const repeat: typeof fetch = async (...args) => {
            const body = await (await deps.request(...args)).json();
            if (body.head.vars.includes('rowCount')) for (const r of body.results.bindings) if (r.internalId.value === '980011') {
                r.internalId.value = '980001'; r.title.value = initial.title; r.url.value = initial.canonical_url;
            }
            return new Response(JSON.stringify(body),{ headers: { 'content-type': 'application/sparql-results+json' } });
        };
        const second = await fetchPage(root,'fixture',null,{ ...deps,request: repeat });
        await t.test('B/C/F: second page, stable external identity, rollback retains artifact and cursor',async () => {
            assert.ok(second.resources.every(r => !first.resources.includes(r))); assert.equal(second.resources.length,2);
            const before = await counts();
            await owner.query(`CREATE FUNCTION course_sync.test_incremental_fail() RETURNS trigger LANGUAGE plpgsql AS $$
                BEGIN RAISE EXCEPTION 'TEST_INCREMENTAL_ROLLBACK'; END $$;
                CREATE TRIGGER test_incremental_fail BEFORE UPDATE ON course_sync.checkpoints FOR EACH ROW EXECUTE FUNCTION course_sync.test_incremental_fail()`);
            try {
                await assert.rejects(applyPage(root,'fixture',staging,target),/TEST_INCREMENTAL_ROLLBACK/);
                assert.deepEqual(await counts(),before); assert.equal((await status(root,'fixture')).confirmedCursor,first.cursorNext);
                assert.equal((await status(root,'fixture')).pending!.runId,second.run.runId);
            } finally { await owner.query('DROP TRIGGER test_incremental_fail ON course_sync.checkpoints; DROP FUNCTION course_sync.test_incremental_fail()'); }
        });
        await t.test('G: lost COMMIT response replays same artifact, no extra HTTP, local cursor confirms after receipt',async () => {
            const client = await writer.connect(), query = client.query.bind(client);
            const cm = t.mock.method(writer,'connect',async () => client);
            const qm = t.mock.method(client,'query',(async (...args: any[]) => {
                const r = await (query as any)(...args); if (args[0] === 'COMMIT') throw Error('TEST_LOST_COMMIT_RESPONSE'); return r;
            }) as any);
            try { await assert.rejects(applyPage(root,'fixture',staging,target),/COMMIT_UNCERTAIN_RETRY_SAME_RUN/); }
            finally { qm.mock.restore(); cm.mock.restore(); }
            assert.equal((await status(root,'fixture')).confirmedCursor,first.cursorNext);
            const report = await applyPage(root,'fixture',staging,target); assert.equal(report.result.replay,true);
            assert.equal((await status(root,'fixture')).confirmedCursor,second.cursorNext); assert.equal(calls,4);
            const c = await counts(); assert.equal(c.candidates,'11'); assert.equal(c.observations,'13'); assert.equal(c.runs,'2'); assert.equal(c.checkpoint,second.run.runId);
            const current = (await rows())[0]; assert.equal(current.candidate_id,initial.candidate_id);
            assert.equal(current.observed.durationMinutes,90); assert.deepEqual(current.verified,reviewed.verified);
            assert.equal(current.review_state,reviewed.review_state); assert.equal(current.published_course_id,reviewed.published_course_id);
            assert.equal((await owner.query("SELECT document FROM course_sync.observations WHERE run_id=$1 AND document->>'externalId'=$2",[second.run.runId,'980001'])).rows[0].document.durationMinutes,null);
        });
        await t.test('I: genuine editorial conflict and version conflict preserved; public DML unavailable',async () => {
            clock += 10000;
            const changed: typeof fetch = async (...args) => {
                const body = await (await transport(...args)).json();
                if (body.head.vars.includes('rowCount')) for (const r of body.results.bindings) r.title.value = '[TEST] Contradiction';
                return new Response(JSON.stringify(body),{ headers: { 'content-type': 'application/sparql-results+json' } });
            };
            const conflict = await preparePage({ cursor: null,size: 1,runId: 'TEST-incremental-editorial-conflict',observedAt: new Date(clock).toISOString() },changed,async () => {},new Set());
            const snap = await staging.load();
            await editor.query("UPDATE course_sync.candidates SET verified_by='TEST-concurrent-editor' WHERE candidate_id=$1",[initial.candidate_id]);
            const versionResult = await staging.execute(conflict.run,snap.versions);
            assert.ok(versionResult.actions.some(a => a.reason === 'VERSION_CONFLICT'));
            clock += 1000;
            const fresh = await preparePage({ cursor: null,size: 1,runId: conflict.run.runId + '-next',observedAt: new Date(clock).toISOString() },changed,async () => {},new Set());
            const r = await staging.execute(fresh.run);
            assert.ok(r.actions.some(a => a.reason === 'EDITORIAL_CONFLICT'));
            const current = (await rows())[0]; assert.deepEqual(current.verified,reviewed.verified); assert.equal(current.title,initial.title);
            assert.equal(current.review_state,reviewed.review_state); assert.equal(current.published_course_id,reviewed.published_course_id);
            assert.equal((await rows())[1].review_state,'pending');
            for (const table of ['courses','skills','course_skills']) await assert.rejects(writer.query(`DELETE FROM public.${table}`),(e: any) => e.code === '42501');
            assert.deepEqual(await publicRows(),beforePublic); assert.ok((await rows()).every(r => r.missing_count === 0));
        });
        await t.test('failed incremental request records failed receipt with no deactivation or cursor movement',async () => {
            clock += 10000;
            const failedRoot = join(root,'failure'); await initialize(failedRoot,'fixture',null);
            const failed = await fetchPage(failedRoot,'fixture',null,{ ...deps,request: async () => new Response('',{ status: 429 }) });
            const before = await rows(); const r = await applyPage(failedRoot,'fixture',staging,target);
            assert.equal(r.result.absenceEligible,false); assert.equal((await status(failedRoot,'fixture')).confirmedCursor,null);
            assert.deepEqual(await rows(),before); assert.equal((await staging.history('openlearn',1))[0]!.status,'failed');
            assert.equal((await counts()).checkpoint,failed.run.runId);
        });
    } finally {
        await writer.end(); await editor.end(); assert.ok(resolve(root).startsWith(resolve(tmpdir()))); await rm(root,{ recursive: true,force: true });
    }
}));
