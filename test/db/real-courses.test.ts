import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtemp, writeFile, unlink, rmdir } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { Pool } from 'pg';
import { migrate } from '../../src/db/migrate.js';
import { getDatabaseConfig } from '../../src/db/config.js';
import { createApp } from '../../src/app.js';
import { createPostgresCoursesRepository } from '../../src/repositories/courses.repository.js';
import { createPostgresJobCourseRecommendationsRepository } from '../../src/repositories/job-course-recommendations.repository.js';
import { withHttpApp } from '../helpers/http.js';
import { headers, settings } from '../helpers/authenticated-app.js';
import { withTestDatabase } from './helpers/test-database.js';
import { importCatalog } from '../../scripts/catalog-import/importer.js';
import { runCatalogImport } from '../../scripts/import-catalog.js';
import { prepareEditorialCatalog } from '../../scripts/editorial-courses/review.js';
import { realCoursesRegistry, testCourseReview, testReviewTime } from '../fixtures/real-courses.test.js';

test('REAL official courses + TEST authorization: CatalogDocument → import → GET /courses → recommendations on PostgreSQL 17', async t => withTestDatabase(async owner => {
    const httpFetch = globalThis.fetch;
    t.mock.method(globalThis,'fetch',async (input,init) => {
        if (new URL(String(input)).hostname !== '127.0.0.1') throw new Error('EXTERNAL_NETWORK_FORBIDDEN');
        return httpFetch(input,init);
    });
    assert.match((await owner.query('SHOW server_version')).rows[0].server_version,/^17\./);
    await migrate(owner);
    assert.equal((await owner.query('SELECT count(*) FROM public.schema_migrations')).rows[0].count,'5');
    const database = String(owner.options.database);
    // Explicit TEST-only vocabulary provisioning, not a claim about operational public.skills.
    await importCatalog(owner,{ formatVersion: 1,batchId: 'TEST-vocabulary-bootstrap',reviewedAt: testReviewTime,skills: ['Python'],courses: [] },{ apply: true });
    const vocabulary = { names: (await owner.query('SELECT name FROM public.skills ORDER BY name')).rows.map(r => r.name as string),
        reference: `TEST authorized disposable ${database} SELECT name FROM public.skills`,checkedOn: '2026-11-15' };
    assert.deepEqual(vocabulary.names,['Python']);
    const registry = realCoursesRegistry(), review = testCourseReview(registry,vocabulary), prepared = prepareEditorialCatalog(registry,review);
    assert.equal(prepared.purpose,'TEST_ONLY'); assert.equal(prepared.authorizedToPublish,false);
    assert.ok(prepared.catalog);
    const dir = await mkdtemp(join(tmpdir(),'cvexpert-real-course-demo-')),file = join(dir,'TEST-real-catalog.json');
    await writeFile(file,JSON.stringify(prepared.catalog));
    const env = { ...process.env,NODE_ENV: 'test',PGHOST: '127.0.0.1',PGDATABASE: database,DB_SSL_MODE: 'disable',PGSSLROOTCERT: '' };
    await owner.query('GRANT USAGE ON SCHEMA public TO cvexpert_brecha_app');
    await owner.query('GRANT SELECT ON public.courses,public.skills,public.course_skills TO cvexpert_brecha_app');
    const reader = new Pool({ ...getDatabaseConfig(env),user: 'cvexpert_brecha_app',password: process.env.PG_READONLY_PASSWORD });
    const recommendationReader = new Pool({ ...getDatabaseConfig(env),user: 'cvexpert_brecha_app',password: process.env.PG_READONLY_PASSWORD });
    try {
        await t.test('importador local autorizado: preview sin DML, dos cursos auténticos, una relación Python', async () => {
            const preview = await runCatalogImport(['--file',file],env);
            assert.equal(preview.mode,'dry-run');
            assert.equal((await owner.query('SELECT count(*) FROM public.courses')).rows[0].count,'0');
            assert.equal((await runCatalogImport(['--file',file,'--apply'],env)).mode,'applied');
            const rows = (await owner.query(`SELECT c.title,c.url,c.duration_hours,c.is_paid,ARRAY(
                SELECT s.name FROM public.course_skills cs JOIN public.skills s ON s.id=cs.skill_id WHERE cs.course_id=c.id) AS skills
                FROM public.courses c ORDER BY c.title`)).rows;
            assert.equal(rows.length,2);
            assert.deepEqual(rows.find(r => r.title === 'Simple coding').skills,['Python']);
            assert.equal(rows.find(r => r.title === 'Simple coding').duration_hours,2);
            assert.deepEqual(rows.find(r => r.title === 'Network security').skills,[]);
            assert.ok(rows.every(r => !r.is_paid && r.url.startsWith('https://www.open.edu/openlearn/')));
            const replay = await runCatalogImport(['--file',file,'--apply'],env);
            assert.ok(replay.courses.every(c => c.action === 'unchanged'));
            assert.equal((await owner.query('SELECT count(*) FROM public.course_skills')).rows[0].count,'1');
            assert.equal((await owner.query('SELECT count(*) FROM public.market_requirements')).rows[0].count,'0');
        });
        const courses = createPostgresCoursesRepository(() => reader);
        const recommendations = createPostgresJobCourseRecommendationsRepository(() => recommendationReader);
        await withHttpApp(createApp('test',courses,settings,undefined,undefined,recommendations),async base => {
            await t.test('GET /courses entrega metadatos reales y filtro exacto Python mediante lector SELECT', async () => {
                const response = await fetch(`${base}/courses?skillName=Python`,{ headers });
                assert.equal(response.status,200);
                const page = await response.json() as any;
                assert.equal(page.totalRecords,1); assert.equal(page.items[0].title,'Simple coding');
                assert.equal(page.items[0].durationHours,2); assert.equal(page.items[0].isPaid,false);
                assert.deepEqual(page.items[0].skills,['Python']);
                t.diagnostic(JSON.stringify({ authorization: 'TEST_ONLY',endpoint: 'GET /courses?skillName=Python',result: page }));
            });
            await t.test('Python faltante recomienda Simple coding, SQL sin asociación no recibe cursos', async () => {
                const response = await fetch(`${base}/skills-gap/recommendations`,{ method: 'POST',
                    headers: { ...headers,'X-User-Id': 'TEST-real-course-demo','Content-Type': 'application/json' },
                    body: JSON.stringify({ cv: { id: 'TEST-cv',skills: [] },jobs: [{ id: 'TEST-job',skills: ['Python','SQL'] }] }) });
                assert.equal(response.status,200);
                const result = await response.json() as any;
                const matches = result.results[0].recommendations;
                assert.equal(matches[0].catalogMatch,'matched'); assert.equal(matches[0].courses[0].title,'Simple coding');
                assert.equal(matches[0].courses[0].durationHours,2); assert.equal(matches[0].courses.length,1);
                assert.equal(matches[1].catalogMatch,'not_found'); assert.deepEqual(matches[1].courses,[]);
                t.diagnostic(JSON.stringify({ authorization: 'TEST_ONLY',endpoint: 'POST /skills-gap/recommendations',recommendations: matches }));
            });
            await t.test('lector e ingesta sin permisos de publicación y sin adopción editorial automática', async () => {
                await assert.rejects(reader.query('UPDATE public.courses SET title=title'),(e: any) => e.code === '42501');
                const grants = (await owner.query(`SELECT bool_and(NOT has_table_privilege('cvexpert_sync_ingest',t,'INSERT,UPDATE,DELETE')) AS safe
                    FROM unnest(ARRAY['public.courses','public.skills','public.course_skills']) t`)).rows[0];
                assert.equal(grants.safe,true);
                assert.equal((await owner.query('SELECT count(*) FROM course_sync.candidates')).rows[0].count,'0');
                const before = (await owner.query('SELECT * FROM public.courses ORDER BY id')).rows;
                const changed = structuredClone(prepared.catalog!); changed.courses[0]!.title = 'TEST unauthorized overwrite';
                await assert.rejects(importCatalog(owner,changed,{ apply: true }),/Conflictos/);
                assert.deepEqual((await owner.query('SELECT * FROM public.courses ORDER BY id')).rows,before);
            });
        });
    } finally {
        if (!reader.ended) await reader.end();
        if (!recommendationReader.ended) await recommendationReader.end();
        await unlink(file); await rmdir(dir);
    }
}));
