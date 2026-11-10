import assert from 'node:assert/strict';
import { request } from 'node:http';
import { test } from 'node:test';
import type { Pool } from 'pg';
import { createApp } from '../src/app.js';
import type { CatalogCourse } from '../src/models/courses.js';
import { createPostgresJobCourseRecommendationsRepository } from '../src/repositories/job-course-recommendations.repository.js';
import { createJobCourseRecommendationsService } from '../src/services/job-course-recommendations.service.js';
import { evaluateJobSkillsGap } from '../src/services/job-skills-gap.service.js';
import { headers, settings } from './helpers/authenticated-app.js';
import { withHttpApp } from './helpers/http.js';

const cv = { id: '123', skills: [{ name: 'Java', level: 'advanced' }] };
const body = { cv, jobs: [
    { id: '1', skills: ['Java', 'Docker', ' sql ', 'JavaScript'] },
    { id: '2', skills: ['DOCKER'] },
    { id: '3', skills: ['Java'] },
    { id: '4', skills: [] },
] };
const shared: CatalogCourse = {
    id: '20', title: 'Contenedores y consultas', platform: 'Catálogo local', url: 'https://fixture.catalog.local/20',
    logoUrl: null, durationHours: null, isPaid: false, skills: ['Docker', 'SQL'],
};

test('reutiliza la evaluación y consulta una vez las claves únicas de todas las ofertas', async () => {
    let calls = 0;
    const recommend = createJobCourseRecommendationsService({
        async findBySkillKeys(keys) {
            calls++;
            assert.deepEqual([...keys], ['docker', 'sql', 'javascript']);
            return new Map([
                ['docker', { catalogMatch: 'matched', courses: [shared] }],
                ['sql', { catalogMatch: 'matched', courses: [shared] }],
            ]);
        },
    });
    const { catalogStatus, results, ...envelope } = await recommend(body);
    assert.equal(calls, 1);
    assert.equal(catalogStatus, 'consulted');
    assert.deepEqual({ ...envelope, results: results.map(({ recommendations: _courses, ...result }) => result) },
        evaluateJobSkillsGap(body));
    assert.deepEqual(results.map(result => result.recommendations), [[
        { skillName: 'Docker', catalogMatch: 'matched', courses: [shared] },
        { skillName: 'sql', catalogMatch: 'matched', courses: [shared] },
        { skillName: 'JavaScript', catalogMatch: 'not_found', courses: [] },
    ], [{ skillName: 'DOCKER', catalogMatch: 'matched', courses: [shared] }], [], []]);
});

test('el repositorio ejecuta lecturas en lote parametrizadas y libera la conexión y el pool', async () => {
    const calls: { sql: string; params?: unknown[] }[] = [];
    let released = false;
    let ended = false;
    const attack = "'; drop table public.courses; --";
    const pool = {
        async connect() {
            return {
                async query(sql: string, params?: unknown[]) {
                    calls.push({ sql, params });
                    if (sql.startsWith('SELECT id, name')) return { rows: [
                        { id: 10, name: attack }, { id: 20, name: 'SQL' },
                        { id: 30, name: 'Gestión' }, { id: 40, name: 'Gestion' }, { id: 50, name: 'GESTION' },
                    ] };
                    return { rows: [] };
                },
                release() { released = true; },
            };
        },
        async end() { ended = true; },
    } as unknown as Pool;
    const repository = createPostgresJobCourseRecommendationsRepository(() => pool);
    const matches = await repository.findBySkillKeys(new Set([attack, 'sql', 'gestion']));
    assert.deepEqual(matches.get('gestion'), { catalogMatch: 'ambiguous', courses: [] });
    const reads = calls.filter(({ sql }) => sql.trimStart().startsWith('SELECT'));
    assert.equal(reads.length, 2);
    assert.match(reads[1]!.sql, /unnest\(\$1::integer\[\]\)/);
    assert.match(reads[1]!.sql, /LIMIT \$2::integer/);
    assert.deepEqual(reads[1]!.params?.slice(0, 2), [[10, 20], 5]);
    assert.ok(calls.every(({ sql }) => !sql.includes(attack)));
    assert.ok(released);
    await repository.close?.();
    assert.ok(ended);
});

const auth = { ...headers, 'X-User-Id': 'fixture-user', 'Content-Type': 'application/json' };
function post(url: string, path: string, input = JSON.stringify(body), requestHeaders = auth as HeadersInit) {
    return fetch(`${url}/skills-gap/${path}`, { method: 'POST', headers: requestHeaders, body: input });
}

test('HTTP diferencia catálogo vacío, innecesario y no disponible, y mantiene el evaluador independiente', async () => {
    let calls = 0;
    let fail = false;
    const app = createApp('test', undefined, settings, undefined, undefined, {
        async findBySkillKeys() {
            calls++;
            if (fail) throw new Error('contraseña PostgreSQL de prueba');
            return new Map();
        },
    });
    await withHttpApp(app, async url => {
        const empty = await post(url, 'recommendations');
        assert.equal(empty.status, 200);
        assert.equal(empty.headers.get('cache-control'), 'no-store');
        const emptyBody = await empty.json() as Awaited<ReturnType<ReturnType<typeof createJobCourseRecommendationsService>>>;
        assert.equal(emptyBody.catalogStatus, 'consulted');
        assert.deepEqual(emptyBody.results[0]!.recommendations[0], {
            skillName: 'Docker', catalogMatch: 'not_found', courses: [],
        });
        assert.equal(calls, 1);
        fail = true;
        const noGaps = await post(url, 'recommendations', JSON.stringify({ cv, jobs: body.jobs.slice(2) }));
        assert.equal(noGaps.status, 200);
        const noGapsBody = await noGaps.json() as typeof emptyBody;
        assert.equal(noGapsBody.catalogStatus, 'not_needed');
        assert.deepEqual(noGapsBody.results.map(r => [r.status, r.recommendations]),
            [['complete', []], ['insufficient_information', []]]);
        assert.equal(calls, 1);
        const error = await post(url, 'recommendations');
        assert.equal(error.status, 503);
        assert.equal(error.headers.get('cache-control'), 'no-store');
        assert.deepEqual(await error.json(), { error: 'CATALOG_UNAVAILABLE', message: 'El catálogo no está disponible temporalmente.' });
        const pure = await post(url, 'evaluate');
        assert.equal(pure.status, 200);
        assert.deepEqual(await pure.json(), evaluateJobSkillsGap(body));
        assert.equal(calls, 2);
    });
});

test('HTTP exige certificado e identidad única y rechaza JSON, cuerpo excesivo, query y userId', async () => {
    const app = createApp('test', undefined, settings, undefined, undefined, {
        async findBySkillKeys() { assert.fail('La entrada inválida no consulta el catálogo.'); },
    });
    await withHttpApp(app, async url => {
        const cases = [
            ['recommendations', 403, 'APIM_CERTIFICATE_REQUIRED', '{', { ...auth, 'X-ARR-ClientCert': 'invalid' }],
            ['recommendations', 401, 'USER_IDENTITY_REQUIRED', '{', headers],
            ['recommendations', 400, 'INVALID_JSON_BODY', '{'],
            ['recommendations', 413, 'INVALID_JSON_BODY', JSON.stringify({ padding: 'x'.repeat(102400) })],
            ['recommendations', 400, 'INVALID_EVALUATION_INPUT', JSON.stringify({ ...body, userId: 'victim' })],
            ['recommendations?userId=victim', 400, 'INVALID_QUERY'],
        ] as const;
        for (const [path, status, error, input, requestHeaders] of cases) {
            const response = await post(url, path, input, requestHeaders);
            assert.equal(response.status, status);
            assert.equal(response.headers.get('cache-control'), 'no-store');
            assert.equal((await response.json() as { error: string }).error, error);
        }
        const duplicate = await new Promise<number | undefined>((resolve, reject) => {
            const req = request(`${url}/skills-gap/recommendations`, {
                method: 'POST', headers: { ...headers, 'X-User-Id': ['a', 'b'] },
            }, res => { res.resume(); resolve(res.statusCode); });
            req.on('error', reject);
            req.end();
        });
        assert.equal(duplicate, 401);
    });
    await withHttpApp(createApp('test', undefined, { APIM_ALLOW_INSECURE_LOCAL: 'true' }), async url => {
        assert.equal((await post(url, 'recommendations')).status, 403);
    });
});
