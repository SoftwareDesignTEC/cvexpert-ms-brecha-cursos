import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { Pool } from 'pg';
import { CatalogConflictError, importCatalog } from '../../scripts/catalog-import/importer.js';
import { getDatabaseConfig } from '../../src/db/config.js';
import { migrate } from '../../src/db/migrate.js';
import { createPostgresCoursesRepository } from '../../src/repositories/courses.repository.js';
import { createApp, fetch } from '../helpers/authenticated-app.js';
import { withHttpApp } from '../helpers/http.js';
import { withTestDatabase } from './helpers/test-database.js';

const file = fileURLToPath(new URL('../fixtures/catalog-import.test.json', import.meta.url));
const fixture = JSON.parse(await readFile(file, 'utf8'));
const fresh = () => structuredClone(fixture);
const execute = promisify(execFile);
test('importación de catálogo con PostgreSQL 17 desechable', async t => withTestDatabase(async owner => {
    assert.match((await owner.query('SHOW server_version')).rows[0].server_version, /^17\./);
    await migrate(owner);
    const snapshot = async () => (await owner.query(`SELECT
        (SELECT jsonb_agg(s ORDER BY id) FROM public.skills s) AS skills,
        (SELECT jsonb_agg(c ORDER BY id) FROM public.courses c) AS courses,
        (SELECT jsonb_agg(cs ORDER BY course_id, skill_id) FROM public.course_skills cs) AS links`)).rows;
    const cliEnv = { ...process.env, PGDATABASE: String(owner.options.database) };
    const cli = (args: string[], env = cliEnv) => execute(process.execPath,
        ['--import', 'tsx', 'scripts/import-catalog.ts', '--file', file, ...args], { env, timeout: 15000 });

    await t.test('CLI: dry-run sin DML, primera aplicación, NULL y repetición idempotente', async () => {
        const empty = await snapshot();
        const plan = JSON.parse((await cli([])).stdout);
        assert.equal(plan.mode, 'dry-run'); assert.equal(plan.provenancePersisted, false);
        assert.equal(plan.associations.filter((a: any) => a.action === 'insert').length, 3);
        assert.deepEqual(await snapshot(), empty);
        assert.equal(JSON.parse((await cli(['--apply'])).stdout).mode, 'applied');
        const before = await snapshot();
        assert.equal(before[0].skills.length, 2); assert.equal(before[0].courses.length, 2); assert.equal(before[0].links.length, 3);
        assert.equal(before[0].courses[0].duration_hours, null); assert.equal(before[0].courses[0].logo_url, null);
        const again = await importCatalog(owner, fresh(), { apply: true });
        assert.deepEqual(again.courses.map(c => c.action), ['unchanged', 'unchanged']);
        assert.ok(again.skills.every(s => s.action === 'existing'));
        assert.ok(again.associations.every(s => s.action === 'existing'));
        assert.deepEqual(await snapshot(), before);
    });
    await t.test('conflictos de campos y conjuntos de habilidades rechazan todo el lote', async () => {
        const before = await snapshot();
        for (const field of ['title', 'platform', 'isPaid', 'durationHours', 'logoUrl', 'skills']) {
            const doc = fresh();
            const values: Record<string, unknown> = { title: '[TEST] Changed', platform: '[TEST] Other', isPaid: true,
                durationHours: 5, logoUrl: 'https://example.org/test/other', skills: ['[TEST] Skill A'] };
            doc.courses[0][field] = values[field];
            doc.skills.push('[TEST] Must rollback');
            const plan = await importCatalog(owner, doc);
            assert.equal(plan.conflicts, 1); assert.deepEqual(plan.courses[0].differences, [field]);
            await assert.rejects(importCatalog(owner, doc, { apply: true }), CatalogConflictError);
            assert.deepEqual(await snapshot(), before);
        }
        const added = fresh(); added.skills.push('[TEST] New association'); added.courses[0].skills.push('[TEST] New association');
        assert.equal((await importCatalog(owner, added)).associations.at(-2)?.action, 'conflict');
        await assert.rejects(importCatalog(owner, added, { apply: true }), CatalogConflictError);
        const reordered = fresh(); reordered.courses[0].skills.reverse();
        assert.equal((await importCatalog(owner, reordered)).conflicts, 0);
    });
    await t.test('habilidades existentes fuera del lote y referencias ausentes', async () => {
        const doc = fresh(); doc.skills = []; doc.courses = [doc.courses[0]]; doc.courses[0].url += '-new';
        await importCatalog(owner, doc, { apply: true });
        doc.courses[0].skills.push('[TEST] Missing');
        await assert.rejects(importCatalog(owner, doc, { apply: true }), /ausente/);
    });
    await t.test('CLI en conflicto devuelve informe rejected y salida 1 sin escrituras', async () => {
        const dir = await mkdtemp(join(tmpdir(), 'catalog-conflict-'));
        const input = join(dir, 'conflict.json'), doc = fresh(), before = await snapshot();
        doc.courses[0].title = '[TEST] Conflicting CLI';
        try {
            await writeFile(input, JSON.stringify(doc));
            await assert.rejects(execute(process.execPath,
                ['--import', 'tsx', 'scripts/import-catalog.ts', '--file', input, '--apply'], { env: cliEnv, timeout: 15000 }),
            (e: any) => e.code === 1 && JSON.parse(e.stdout).mode === 'rejected' && /sin escrituras/.test(e.stderr));
            assert.deepEqual(await snapshot(), before);
        } finally { await rm(dir, { recursive: true }); }
    });
    await t.test('restricción posterior a inserciones revierte habilidades, cursos y relaciones', async () => {
        const doc = fresh(); doc.skills = ['[TEST] Rollback'];
        doc.courses.forEach((c: any, i: number) => { c.url += '-rollback'; c.skills = doc.skills; c.title = i ? '[TEST] Reject' : '[TEST] First write'; });
        const before = await snapshot();
        await owner.query("ALTER TABLE public.courses ADD CONSTRAINT test_catalog_failure CHECK (title <> '[TEST] Reject')");
        try {
            await assert.rejects(importCatalog(owner, doc, { apply: true }), (e: any) => e.code === '23514');
            assert.deepEqual(await snapshot(), before);
        } finally { await owner.query('ALTER TABLE public.courses DROP CONSTRAINT test_catalog_failure'); }
    });
    await t.test('inyección se rechaza sin ejecutar SQL externo; apóstrofes legítimos son datos', async () => {
        const before = await snapshot(), doc = fresh();
        doc.skills.push("'; DROP TABLE public.skills; --");
        await assert.rejects(importCatalog(owner, doc, { apply: true }));
        assert.deepEqual(await snapshot(), before);
        const literal = fresh(); literal.courses = [literal.courses[0]];
        literal.courses[0].url += '-apostrophe'; literal.courses[0].title = "[TEST] O'Reilly";
        await importCatalog(owner, literal, { apply: true });
        assert.equal((await owner.query('SELECT title FROM public.courses WHERE url=$1', [literal.courses[0].url])).rows[0].title, "[TEST] O'Reilly");
    });
    await t.test('dos aplicaciones concurrentes insertan una sola vez', async () => {
        const doc = fresh(); doc.skills = ['[TEST] Concurrent'];
        doc.courses.forEach((c: any) => { c.url += '-concurrent'; c.skills = doc.skills; });
        const results = await Promise.all([importCatalog(owner, doc, { apply: true }), importCatalog(owner, doc, { apply: true })]);
        assert.deepEqual(results.map(r => r.courses[0].action).sort(), ['insert', 'unchanged']);
    });
    await t.test('apply fija READ COMMITTED aunque la sesión tenga otro aislamiento por defecto', async () => {
        const pool = new Pool({ ...getDatabaseConfig(), database: owner.options.database,
            options: '-c default_transaction_isolation=repeatable\\ read' });
        try {
            const doc = fresh(); doc.skills = ['[TEST] Isolation'];
            doc.courses.forEach((c: any) => { c.url += '-isolation'; c.skills = doc.skills; });
            const results = await Promise.all([importCatalog(pool, doc, { apply: true }), importCatalog(pool, doc, { apply: true })]);
            assert.deepEqual(results.map(r => r.courses[0].action).sort(), ['insert', 'unchanged']);
        } finally { await pool.end(); }
    });
    await t.test('rol HTTP y sesión efectiva prohibidos; /courses consume catálogo importado', async () => {
        assert.ok(process.env.PG_READONLY_PASSWORD);
        await owner.query('GRANT USAGE ON SCHEMA public TO cvexpert_brecha_app');
        await owner.query('GRANT SELECT ON public.skills, public.courses, public.course_skills TO cvexpert_brecha_app');
        const reader = new Pool({ ...getDatabaseConfig(), database: owner.options.database,
            user: 'cvexpert_brecha_app', password: process.env.PG_READONLY_PASSWORD });
        try {
            await assert.rejects(importCatalog(reader, fresh()), /rol HTTP/);
            const disguised = { options: owner.options, connect: reader.connect.bind(reader) } as unknown as Pool;
            await assert.rejects(importCatalog(disguised, fresh()), /Sesión SQL/);
            await withHttpApp(createApp('test', createPostgresCoursesRepository(() => reader)), async url => {
                const response = await fetch(`${url}/courses?skillName=${encodeURIComponent('[TEST] Skill B')}`);
                assert.equal(response.status, 200);
                const page: any = await response.json();
                const course = page.items.find((c: any) => c.url === fixture.courses[0].url);
                assert.ok(course); assert.equal(course.durationHours, null);
                assert.deepEqual(course.skills, fixture.courses[0].skills);
            });
        } finally { if (!reader.ended) await reader.end(); }
    });
    await t.test('CLI bloquea producción/Azure y no imprime secretos de errores de conexión', async () => {
        for (const patch of [{ NODE_ENV: 'production' }, { PGHOST: 'test.postgres.database.azure.com' }, { PGUSER: 'cvexpert_brecha_app' }]) {
            await assert.rejects(cli(['--apply'], { ...cliEnv, ...patch }), (e: any) => /prohibidos/.test(e.stderr));
        }
        await assert.rejects(cli([], { ...cliEnv, PGDATABASE: 'test_missing', PGPASSWORD: 'TEST-secret-not-logged' }),
            (e: any) => /no se publican detalles/.test(e.stderr) && !e.stderr.includes('TEST-secret-not-logged'));
    });
}));
