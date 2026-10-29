import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { Pool } from 'pg';
import { createApp } from '../src/app.js';
import { InvalidCoursesQuery, parseCoursesQuery } from '../src/controllers/courses.controller.js';
import { createPostgresCoursesRepository, type CoursesRepository } from '../src/repositories/courses.repository.js';
import { createCoursesService } from '../src/services/courses.service.js';
import { withHttpApp } from './helpers/http.js';
import { invalidCourseQueries } from './helpers/courses-queries.js';

const emptyRepository: CoursesRepository = { async findPage() { return { items: [], totalRecords: 0 }; } };

test('courses: defaults, bounds, booleans and exact strings without trimming', () => {
    assert.deepEqual(parseCoursesQuery(new URLSearchParams()), { page: 1, pageSize: 20 });
    assert.deepEqual(parseCoursesQuery(new URLSearchParams('page=2&pageSize=100&isPaid=false&platform= X &skillName=SQL&unknown=x')),
        { page: 2, pageSize: 100, isPaid: false, platform: ' X ', skillName: 'SQL' });
    assert.equal(parseCoursesQuery(new URLSearchParams('isPaid=true')).isPaid, true);
    assert.equal(parseCoursesQuery(new URLSearchParams(`page=${Number.MAX_SAFE_INTEGER}`)).page, Number.MAX_SAFE_INTEGER);
    for (const query of invalidCourseQueries) {
        assert.throws(() => parseCoursesQuery(new URLSearchParams(query)), InvalidCoursesQuery, query);
    }
});

test('courses: malformed HTTP queries fail before repository access', async () => {
    let calls = 0;
    const repository: CoursesRepository = { async findPage() { calls++; throw new Error('Should not query'); } };
    await withHttpApp(createApp('test', repository), async url => {
        for (const query of invalidCourseQueries) {
            const response = await fetch(`${url}/courses?${query}`);
            assert.equal(response.status, 400, query);
            assert.deepEqual(await response.json(), { error: 'INVALID_QUERY', message: 'Parámetros de consulta inválidos.' });
        }
        assert.equal(calls, 0);
    });
});

test('courses: empty page HTTP envelope and no-store', async () => {
    await withHttpApp(createApp('test', emptyRepository), async url => {
        const response = await fetch(`${url}/courses`);
        assert.equal(response.status, 200);
        assert.equal(response.headers.get('cache-control'), 'no-store');
        assert.deepEqual(await response.json(), { items: [], page: 1, pageSize: 20, totalRecords: 0 });
    });
});

test('courses service: public string IDs, nulls and exact page metadata', async () => {
    const query = { page: 2, pageSize: 1, isPaid: false, skillName: 'SQL' };
    const service = createCoursesService({ async findPage(actual) {
        assert.deepEqual(actual, query);
        return { totalRecords: 3, items: [{ id: 10, title: 'Example', platform: 'Example', url: 'https://example.org',
            duration_hours: null, logo_url: null, is_paid: false, skills: ['SQL', 'TypeScript'] }] };
    } });
    assert.deepEqual(await service.getPage(query), {
        items: [{ id: '10', title: 'Example', platform: 'Example', url: 'https://example.org',
            durationHours: null, logoUrl: null, isPaid: false, skills: ['SQL', 'TypeScript'] }],
        page: 2, pageSize: 1, totalRecords: 3,
    });
});

test('repository: binds SQL inputs and computes huge offset without rounding', async () => {
    const attack = "' OR TRUE; DROP TABLE courses; --";
    let calls = 0;
    const pool = { async query(sql: string, values: unknown[]) {
        calls++;
        assert.ok(!sql.includes(attack));
        assert.deepEqual(values, [attack, false, attack, 100, '900719925474099000']);
        return { rows: [{ items: [], total_records: '3' }] };
    } } as unknown as Pool;
    const repository = createPostgresCoursesRepository(() => pool);
    assert.deepEqual(await repository.findPage({ page: Number.MAX_SAFE_INTEGER, pageSize: 100,
        platform: attack, isPaid: false, skillName: attack }), { items: [], totalRecords: 3 });
    assert.equal(calls, 1);
});

test('repository: refuses an unrepresentable total instead of returning rounded metadata', async () => {
    const pool = { async query() { return { rows: [{ items: [], total_records: '9007199254740992' }] }; } } as unknown as Pool;
    const repository = createPostgresCoursesRepository(() => pool);
    await assert.rejects(repository.findPage({ page: 1, pageSize: 20 }), /rango representable/);
});

test('pool is lazy; health and skills-gap survive configuration/connection errors without leaking details', async () => {
    let attempts = 0;
    let closed = 0;
    const secretError = 'password=DO_NOT_EXPOSE SELECT secret FROM sensitive host=internal';
    const pool = { async query() { throw new Error(secretError); }, async end() { closed++; } } as unknown as Pool;
    const repository = createPostgresCoursesRepository(() => { attempts++; return pool; });
    await withHttpApp(createApp('test', repository), async url => {
        assert.equal(attempts, 0);
        assert.equal((await fetch(`${url}/health`)).status, 200);
        assert.equal((await fetch(`${url}/skills-gap`)).status, 200);
        assert.equal(attempts, 0);
        const response = await fetch(`${url}/courses`);
        assert.equal(response.status, 503);
        assert.deepEqual(await response.json(), { error: 'CATALOG_UNAVAILABLE', message: 'El catálogo no está disponible temporalmente.' });
        assert.equal(attempts, 1);
        assert.equal((await fetch(`${url}/health`)).status, 200);
    });
    assert.equal(closed, 1);
    await withHttpApp(createApp('production', createPostgresCoursesRepository(() => { throw new Error(secretError); })), async url => {
        assert.equal((await fetch(`${url}/health`)).status, 200);
        assert.equal((await fetch(`${url}/skills-gap`)).status, 503);
        assert.equal((await fetch(`${url}/courses`)).status, 503);
    });
});
