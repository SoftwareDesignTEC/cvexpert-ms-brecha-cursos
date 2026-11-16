import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readFile } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import { Pool } from 'pg';
import { withTestDatabase } from './helpers/test-database.js';
import { migrate } from '../../src/db/migrate.js';
import { getDatabaseConfig } from '../../src/db/config.js';
import { createApp } from '../../src/app.js';
import { createPostgresCoursesRepository } from '../../src/repositories/courses.repository.js';
import { createPostgresJobCourseRecommendationsRepository } from '../../src/repositories/job-course-recommendations.repository.js';
import { withHttpApp } from '../helpers/http.js';
import { headers,settings } from '../helpers/authenticated-app.js';
import { ingestOnce } from '../../src/ingestion/runtime.js';
import { discoverOpenLearn,discoverFreeCodeCamp,IngestError } from '../../src/ingestion/providers.js';
import { automaticTransport } from '../fixtures/automatic-courses.test.js';

test('automatic catalog MVP: two authentic metadata sources → INSERT-only PostgreSQL 17 → existing HTTP/recommendations',async t => withTestDatabase(async owner => {
    const http = globalThis.fetch;
    t.mock.method(globalThis,'fetch',async (url,options) => {
        if (new URL(String(url)).hostname !== '127.0.0.1') throw Error('EXTERNAL_NETWORK_FORBIDDEN'); return http(url,options);
    });
    assert.match((await owner.query('SHOW server_version')).rows[0].server_version,/^17\./);
    await migrate(owner); const database = String(owner.options.database);
    assert.equal((await owner.query('SELECT count(*) FROM public.schema_migrations')).rows[0].count,'5');
    await owner.query("SELECT set_config('cvexpert.course_ingest_grants_database',$1,false)",[database]);
    await owner.query(await readFile(new URL('../../db/course-automatic-ingest-grants.sql',import.meta.url),'utf8'));
    await owner.query('GRANT USAGE ON SCHEMA public TO cvexpert_brecha_app; GRANT SELECT ON public.courses,public.skills,public.course_skills TO cvexpert_brecha_app');
    await owner.query("INSERT INTO public.skills(name) VALUES('SQL'); INSERT INTO public.courses(title,platform,url,is_paid) VALUES('[TEST] Manual protected','TEST','https://example.org/TEST/manual',true); INSERT INTO public.course_skills SELECT c.id,s.id FROM public.courses c CROSS JOIN public.skills s");
    const config = { ...getDatabaseConfig(),database };
    const writer = new Pool({ ...config,user: 'cvexpert_course_ingest',password: 'TEST-course-ingest-only' });
    const reader = new Pool({ ...config,user: 'cvexpert_brecha_app',password: process.env.PG_READONLY_PASSWORD });
    const recommendationReader = new Pool({ ...config,user: 'cvexpert_brecha_app',password: process.env.PG_READONLY_PASSWORD });
    let requests = 0;
    const transport: typeof fetch = async (...args) => { requests++; return automaticTransport()(...args); };
    const providers = { openlearn: () => discoverOpenLearn(transport),freecodecamp: () => discoverFreeCodeCamp(transport) };
    const rows = async () => (await owner.query('SELECT * FROM public.courses ORDER BY id')).rows;
    const links = async () => (await owner.query('SELECT * FROM public.course_skills ORDER BY course_id,skill_id')).rows;
    try {
        await t.test('first ingestion stores six verified courses, links and nulls; original manual row/link remain',async () => {
            const before = await rows(), oldLinks = await links(), report = await ingestOnce(writer,providers);
            assert.equal(report.status,'complete'); assert.equal(requests,4);
            assert.deepEqual(report.sources.map(s => 'inserted' in s && [s.provider,s.found,s.inserted,s.associations]),[['openlearn',3,2,2],['freecodecamp',4,4,6]]);
            const current = await rows(); assert.equal(current.length,7); assert.deepEqual(current[0],before[0]);
            assert.deepEqual((await links()).filter(r => r.course_id === before[0].id),oldLinks);
            assert.ok(current.slice(1).every(c => c.is_paid === false && c.duration_hours === null));
        });
        await t.test('repeat is idempotent; changed source metadata cannot overwrite reviewed courses or associations',async () => {
            const before = await rows(), associations = await links();
            const r = await ingestOnce(writer,providers); assert.ok(r.sources.every(s => 'inserted' in s && s.inserted === 0 && s.existing > 0));
            assert.deepEqual(await rows(),before); assert.deepEqual(await links(),associations);
            const changed = await discoverFreeCodeCamp(automaticTransport()); changed.courses[0]!.title = '[TEST] Unapproved source change'; changed.courses[0]!.skills = ['SQL'];
            await ingestOnce(writer,{ ...providers,freecodecamp: async () => changed });
            assert.deepEqual(await rows(),before); assert.deepEqual(await links(),associations);
        });
        await t.test('one failed source does not roll back the other; 429 carries backoff, no removals',async () => {
            const before = await rows(), associations = await links();
            const r = await ingestOnce(writer,{ ...providers,openlearn: async () => { throw new IngestError('PROVIDER_RATE_LIMITED',86400000); } });
            assert.equal(r.status,'partial'); assert.equal((r.sources[0] as any).retryAfterMs,86400000);
            assert.equal((r.sources[1] as any).existing,4); assert.deepEqual(await rows(),before); assert.deepEqual(await links(),associations);
        });
        await t.test('manually reviewed title/duration and added associations remain byte-for-byte intact',async () => {
            await owner.query("UPDATE public.courses SET title='[TEST] Editorial presentation',duration_hours=25 WHERE url='https://www.open.edu/openlearn/digital-computing/network-security/content-section-0'");
            await owner.query("INSERT INTO public.course_skills SELECT c.id,s.id FROM public.courses c CROSS JOIN public.skills s WHERE c.url='https://www.open.edu/openlearn/digital-computing/network-security/content-section-0' AND s.name='SQL'");
            const before = await rows(), associations = await links(); await ingestOnce(writer,providers);
            assert.deepEqual(await rows(),before); assert.deepEqual(await links(),associations);
        });
        await t.test('dedicated role cannot UPDATE/DELETE/DDL, API cannot INSERT; owner/API identities rejected before HTTP',async () => {
            for (const sql of ['UPDATE public.courses SET title=title','DELETE FROM public.courses','DELETE FROM public.course_skills',
                'UPDATE public.skills SET name=name','CREATE TABLE public.test_forbidden(id int)','SELECT setval(\'public.courses_id_seq\',1)']) {
                await assert.rejects(writer.query(sql),(e: any) => e.code === '42501');
            }
            await assert.rejects(reader.query("INSERT INTO public.skills(name) VALUES('TEST-forbidden')"),(e: any) => e.code === '42501');
            const before = requests;
            await assert.rejects(ingestOnce(owner,providers),/LIMITED_INGEST_IDENTITY_REQUIRED/);
            await assert.rejects(ingestOnce(reader,providers),/LIMITED_INGEST_IDENTITY_REQUIRED/); assert.equal(requests,before);
            await owner.query('GRANT UPDATE(title) ON public.courses TO cvexpert_course_ingest');
            try { await assert.rejects(ingestOnce(writer,providers),/PRIVILEGES/); } finally { await owner.query('REVOKE UPDATE(title) ON public.courses FROM cvexpert_course_ingest'); }
        });
        await t.test('PostgreSQL session lock excludes concurrent processes before provider HTTP',async () => {
            const lock = await writer.connect();
            await lock.query('SELECT pg_advisory_lock(834921,6)'); const before = requests;
            try {
                assert.equal((await ingestOnce(writer,providers)).status,'locked'); assert.equal(requests,before);
                const child = spawnSync(process.execPath,['--input-type=module','-e',
                    `process.argv=['node','dist/ingestion/cli.js'];globalThis.fetch=async()=>{throw Error('EXTERNAL_NETWORK_FORBIDDEN')};await import('./dist/ingestion/cli.js');`],
                { encoding: 'utf8',env: { ...process.env,COURSES_INGEST_HOST: '127.0.0.1',COURSES_INGEST_PORT: String(config.port),
                    COURSES_INGEST_DATABASE: database,COURSES_INGEST_USER: 'cvexpert_course_ingest',
                    COURSES_INGEST_PASSWORD: 'TEST-course-ingest-only',COURSES_INGEST_SSL_MODE: 'disable' } });
                assert.equal(child.status,0,child.stderr); assert.equal(JSON.parse(child.stdout).status,'locked');
            }
            finally { await lock.query('SELECT pg_advisory_unlock(834921,6)'); lock.release(); }
        });
        await t.test('canonical case collision rejects affected new course; no synonyms fabricated',async () => {
            // Owner removes only this UUID fixture to exercise a fresh course against an ambiguous skill.
            await owner.query("DELETE FROM public.courses WHERE url='https://www.freecodecamp.org/learn/python-v9/'; INSERT INTO public.skills(name) VALUES('python')");
            const r = await ingestOnce(writer,providers);
            assert.ok((r.sources[1] as any).rejected.some((e: any) => e.reason === 'AMBIGUOUS_CANONICAL_SKILL'));
            assert.equal((await owner.query("SELECT count(*) FROM public.courses WHERE url LIKE '%/python-v9/'")).rows[0].count,'0');
            await owner.query("DELETE FROM public.skills WHERE name='python'"); await ingestOnce(writer,providers);
        });
        await t.test('provider SQL failure rolls back its courses and links; other provider still executes; retry recovers',async () => {
            await owner.query("DELETE FROM public.courses WHERE platform='freeCodeCamp'");
            await owner.query(`CREATE FUNCTION public.test_auto_fail() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'TEST-rollback'; END $$;
                CREATE TRIGGER test_auto_fail BEFORE INSERT ON public.course_skills FOR EACH ROW EXECUTE FUNCTION public.test_auto_fail()`);
            try {
                const r = await ingestOnce(writer,providers); assert.equal(r.status,'partial');
                assert.equal((await owner.query("SELECT count(*) FROM public.courses WHERE platform='freeCodeCamp'")).rows[0].count,'0');
            } finally { await owner.query('DROP TRIGGER test_auto_fail ON public.course_skills; DROP FUNCTION public.test_auto_fail()'); }
            assert.equal((await ingestOnce(writer,providers)).status,'complete');
        });
        await withHttpApp(createApp('test',createPostgresCoursesRepository(() => reader),settings,undefined,undefined,
            createPostgresJobCourseRecommendationsRepository(() => recommendationReader)),async base => {
            await t.test('GET /courses returns both providers; missing Python recommends an authentic freeCodeCamp course',async () => {
                const page = await fetch(base + '/courses',{ headers }); assert.equal(page.status,200); const catalog = await page.json() as any;
                assert.ok(catalog.items.some((c: any) => c.platform === 'OpenLearn — The Open University'));
                assert.ok(catalog.items.some((c: any) => c.platform === 'freeCodeCamp'));
                const response = await fetch(base + '/skills-gap/recommendations',{ method: 'POST',headers: { ...headers,'X-User-Id': 'TEST-automatic','Content-Type': 'application/json' },
                    body: JSON.stringify({ cv: { id: 'TEST-cv',skills: [] },jobs: [{ id: 'TEST-job',skills: ['Python'] }] }) });
                assert.equal(response.status,200); const result = await response.json() as any;
                const match = result.results[0].recommendations[0]; assert.equal(match.catalogMatch,'matched');
                assert.equal(match.courses[0].title,'Python Certification'); assert.equal(match.courses[0].url,'https://www.freecodecamp.org/learn/python-v9/');
                assert.deepEqual(match.courses[0].skills,['Python']);
                t.diagnostic(JSON.stringify({ evidence: 'REAL_METADATA_SNAPSHOT_TEST_DATABASE',recommendations: match }));
            });
        });
        // The new writer never acquires any staging privilege or changes the signed importer contract.
        assert.equal((await owner.query('SELECT count(*) FROM course_sync.candidates')).rows[0].count,'0');
    } finally { await writer.end(); if (!reader.ended) await reader.end(); if (!recommendationReader.ended) await recommendationReader.end(); }
}));
