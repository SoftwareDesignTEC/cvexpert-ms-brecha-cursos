import assert from 'node:assert/strict';
import { once } from 'node:events';
import { createServer, type AddressInfo } from 'node:net';
import { test } from 'node:test';
import { Pool } from 'pg';
import { createApp } from '../../src/app.js';
import { getDatabaseConfig } from '../../src/db/config.js';
import { migrate } from '../../src/db/migrate.js';
import { inTransaction } from '../../src/db/transaction.js';
import type { CoursesPage } from '../../src/models/courses.js';
import { createPostgresCoursesRepository } from '../../src/repositories/courses.repository.js';
import { invalidCourseQueries } from '../helpers/courses-queries.js';
import { withHttpApp } from '../helpers/http.js';
import { withTestDatabase } from './helpers/test-database.js';

test('GET /courses con PostgreSQL real y rol exclusivamente SELECT', async t => withTestDatabase(async owner => {
    await migrate(owner);
    // El bootstrap del contenedor CI crea el rol. El dueño de esta base solo
    // concede acceso a sus tres tablas; no modifica roles ni bases de desarrollo.
    assert.ok(process.env.PG_READONLY_PASSWORD, 'Define PG_READONLY_PASSWORD para el rol desechable cvexpert_brecha_app.');
    await owner.query('GRANT USAGE ON SCHEMA public TO cvexpert_brecha_app');
    await owner.query('GRANT SELECT ON public.courses, public.skills, public.course_skills TO cvexpert_brecha_app');
    const reader = new Pool({ ...getDatabaseConfig(), database: owner.options.database,
        user: 'cvexpert_brecha_app', password: process.env.PG_READONLY_PASSWORD });
    try {
        await withHttpApp(createApp('test', createPostgresCoursesRepository(() => reader)), async url => {
            async function getPage(query = ''): Promise<CoursesPage> {
                const response = await fetch(`${url}/courses${query}`);
                assert.equal(response.status, 200, query);
                return await response.json() as CoursesPage;
            }
            await t.test('catálogo vacío mantiene el sobre paginado', async () => {
                assert.deepEqual(await getPage(), { items: [], page: 1, pageSize: 20, totalRecords: 0 });
            });

            // Fixtures [TEST], solo en la base desechable; no son el seed [DEMO].
            await inTransaction(owner, async client => {
                const sql = await client.query<{ id: number }>('INSERT INTO public.skills (name) VALUES ($1) RETURNING id', ['SQL']);
                const typescript = await client.query<{ id: number }>('INSERT INTO public.skills (name) VALUES ($1) RETURNING id', ['TypeScript']);
                for (const [id, platform, paid, duration, logo] of [
                    [30, 'Alpha', false, null, 'https://example.org/logo'],
                    [10, 'Alpha', true, 8, 'https://example.org/logo'],
                    [20, 'Beta', false, 0, null],
                    [2, 'Alpha', false, null, null],
                ] as const) {
                    await client.query(`INSERT INTO public.courses (id, title, platform, url, is_paid, duration_hours, logo_url)
                        OVERRIDING SYSTEM VALUE VALUES ($1, $2, $3, $4, $5, $6, $7)`,
                    [id, `[TEST] Curso ${id}`, platform, `https://example.org/test/${id}`, paid, duration, logo]);
                }
                for (const [course, skill] of [[10, sql.rows[0]!.id], [10, typescript.rows[0]!.id],
                    [20, sql.rows[0]!.id], [30, typescript.rows[0]!.id]]) {
                    await client.query('INSERT INTO public.course_skills (course_id, skill_id) VALUES ($1, $2)', [course, skill]);
                }
            });

            await t.test('orden numérico, cursos únicos con cero/una/múltiples habilidades, IDs string y NULL', async () => {
                const body = await getPage();
                assert.equal(body.totalRecords, 4);
                assert.deepEqual(body.items.map(course => course.id), ['2', '10', '20', '30']);
                assert.deepEqual(body.items.map(course => course.skills), [[], ['SQL', 'TypeScript'], ['SQL'], ['TypeScript']]);
                assert.equal(body.items[0]!.durationHours, null);
                assert.equal(body.items[0]!.logoUrl, null);
                assert.equal(body.items[1]!.durationHours, 8);
                assert.equal(body.items[1]!.logoUrl, 'https://example.org/logo');
                assert.equal(body.items[2]!.durationHours, 0);
                assert.equal(body.items[1]!.isPaid, true);
                for (const item of body.items) {
                    assert.deepEqual(Object.keys(item).sort(), ['durationHours', 'id', 'isPaid', 'logoUrl', 'platform', 'skills', 'title', 'url']);
                }
            });

            await t.test('filtros individuales exactos, desconocidos ignorados y combinaciones AND', async () => {
                for (const [query, ids] of [
                    ['platform=Alpha', ['2', '10', '30']], ['platform=alpha', []], ['platform=%20Alpha%20', []],
                    ['isPaid=true', ['10']], ['isPaid=false', ['2', '20', '30']],
                    ['skillName=SQL', ['10', '20']], ['skillName=sql', []], ['skillName=Missing', []],
                    ['platform=Alpha&isPaid=true&skillName=SQL', ['10']],
                    ['platform=Alpha&isPaid=false&skillName=SQL', []],
                    ['platform=Alpha&isPaid=false&skillName=TypeScript', ['30']], ['unknown=value', ['2', '10', '20', '30']],
                ] as const) {
                    const body = await getPage(`?${query}`);
                    assert.deepEqual(body.items.map(course => course.id), ids, query);
                    assert.equal(body.totalRecords, ids.length, query);
                }
                const filtered = await getPage('?skillName=SQL&pageSize=1');
                assert.deepEqual(filtered.items[0]!.skills, ['SQL', 'TypeScript'], 'El filtro no recorta las habilidades del curso.');
                assert.equal(filtered.totalRecords, 2);
            });

            await t.test('paginación, última página parcial y páginas enormes conservan totalRecords', async () => {
                for (const [page, pageSize, ids] of [
                    [1, 1, ['2']], [2, 2, ['20', '30']], [2, 3, ['30']], [3, 2, []],
                    [1, 100, ['2', '10', '20', '30']], [Number.MAX_SAFE_INTEGER, 100, []],
                ] as const) {
                    const body = await getPage(`?page=${page}&pageSize=${pageSize}`);
                    assert.deepEqual(body.items.map(course => course.id), ids);
                    assert.equal(body.totalRecords, 4);
                    assert.equal(body.page, page);
                    assert.equal(body.pageSize, pageSize);
                }
                assert.deepEqual((await getPage('?page=2')).items, []);
                assert.equal((await getPage('?pageSize=1')).page, 1);
                const filtered = await getPage('?skillName=SQL&page=3&pageSize=1');
                assert.deepEqual(filtered.items, []);
                assert.equal(filtered.totalRecords, 2);
            });

            await t.test('rechaza parámetros malformados, repetidos, arreglos, objetos y NUL', async () => {
                for (const query of invalidCourseQueries) {
                    const response = await fetch(`${url}/courses?${query}`);
                    assert.equal(response.status, 400, query);
                    assert.equal((await response.json() as { error: string }).error, 'INVALID_QUERY');
                }
            });

            await t.test('inyección SQL y comodines son valores literales sin modificar el catálogo', async () => {
                for (const filter of ['platform', 'skillName']) {
                    for (const attack of ["' OR TRUE --", "'; DROP TABLE public.courses; --", '%', '_']) {
                        const body = await getPage(`?${new URLSearchParams({ [filter]: attack })}`);
                        assert.deepEqual(body.items, []);
                        assert.equal(body.totalRecords, 0);
                    }
                }
                assert.equal((await getPage()).totalRecords, 4);
            });

            await t.test('rol real sin privilegios administrativos, escritura, esquema o secuencias', async () => {
                const role = await reader.query(`SELECT current_user AS name, rolsuper, rolcreatedb, rolcreaterole
                    FROM pg_roles WHERE rolname = current_user`);
                assert.deepEqual(role.rows, [{ name: 'cvexpert_brecha_app', rolsuper: false, rolcreatedb: false, rolcreaterole: false }]);
                for (const [statement, values] of [
                    ['INSERT INTO public.skills (name) VALUES ($1)', ['Denied']],
                    ['UPDATE public.courses SET title = $1 WHERE id = $2', ['Denied', 2]],
                    ['DELETE FROM public.course_skills WHERE course_id = $1', [10]],
                    ['CREATE TABLE public.denied (id integer)', []],
                    ['SELECT last_value FROM public.courses_id_seq', []],
                    ['SELECT * FROM public.schema_migrations', []],
                ] as const) {
                    await assert.rejects(reader.query(statement, [...values]), (error: unknown) =>
                        !!error && typeof error === 'object' && 'code' in error && error.code === '42501', statement);
                }
                assert.equal((await getPage()).totalRecords, 4);
            });

            await t.test('health y skills-gap conservan respuestas existentes', async () => {
                assert.deepEqual(await (await fetch(`${url}/health`)).json(), { status: 'ok', service: 'brecha-cursos' });
                const gaps = await fetch(`${url}/skills-gap`);
                assert.equal(gaps.status, 200);
                assert.equal(gaps.headers.get('x-data-mode'), 'demo');
                assert.equal((await gaps.json() as { totalRecords: number }).totalRecords, 3);
            });
        });
    } finally {
        // También cubre fallos anteriores a la primera llamada al repositorio.
        if (!reader.ended) await reader.end();
    }
}));

test('conexión PostgreSQL rechazada devuelve 503 sin detalles y health sigue disponible', async () => {
    const probe = createServer().listen(0, '127.0.0.1');
    if (!probe.listening) await once(probe, 'listening');
    const port = (probe.address() as AddressInfo).port;
    await new Promise<void>((resolve, reject) => probe.close(error => error ? reject(error) : resolve()));
    const repository = createPostgresCoursesRepository(() => new Pool({
        host: '127.0.0.1', port, user: 'not-a-real-user', password: 'do-not-expose', database: 'not-a-real-db',
        connectionTimeoutMillis: 300,
    }));
    await withHttpApp(createApp('production', repository), async url => {
        const response = await fetch(`${url}/courses`);
        assert.equal(response.status, 503);
        assert.deepEqual(await response.json(), { error: 'CATALOG_UNAVAILABLE', message: 'El catálogo no está disponible temporalmente.' });
        assert.equal((await fetch(`${url}/health`)).status, 200);
        assert.equal((await fetch(`${url}/skills-gap`)).status, 503);
    });
});
