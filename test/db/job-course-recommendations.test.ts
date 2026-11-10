import assert from 'node:assert/strict';
import { test } from 'node:test';
import { Pool } from 'pg';
import { createApp } from '../../src/app.js';
import { getDatabaseConfig } from '../../src/db/config.js';
import { migrate } from '../../src/db/migrate.js';
import { createPostgresJobCourseRecommendationsRepository } from '../../src/repositories/job-course-recommendations.repository.js';
import type { createJobCourseRecommendationsService } from '../../src/services/job-course-recommendations.service.js';
import { headers, settings } from '../helpers/authenticated-app.js';
import { withHttpApp } from '../helpers/http.js';
import { withTestDatabase } from './helpers/test-database.js';

type Evaluation = Awaited<ReturnType<ReturnType<typeof createJobCourseRecommendationsService>>>;

test('recomendaciones con PostgreSQL real y rol exclusivamente SELECT', async () => withTestDatabase(async owner => {
    await migrate(owner);
    assert.ok(process.env.PG_READONLY_PASSWORD, 'Define la contraseña del lector desechable.');
    await owner.query('GRANT USAGE ON SCHEMA public TO cvexpert_brecha_app');
    await owner.query('GRANT SELECT ON public.courses, public.skills, public.course_skills TO cvexpert_brecha_app');
    const reader = new Pool({ ...getDatabaseConfig(), database: owner.options.database,
        user: 'cvexpert_brecha_app', password: process.env.PG_READONLY_PASSWORD });
    const repository = createPostgresJobCourseRecommendationsRepository(() => reader);
    try {
        await withHttpApp(createApp('test', undefined, settings, undefined, undefined, repository), async url => {
            const attack = "'; DROP TABLE public.courses; --";
            const cv = { id: '123', skills: [{ name: 'Java', level: 'advanced' }] };
            const jobs = [
                { id: '456', skills: [' Docker ', ' sql ', 'JavaScript', 'C++', 'Gestión', 'CI CD', 'Sin cursos', attack] },
                { id: '789', skills: ['docker', 'DOCKER', 'Java'] },
            ];
            const post = (path = 'recommendations') => fetch(`${url}/skills-gap/${path}`, {
                method: 'POST', headers: { ...headers, 'X-User-Id': 'fixture-user', 'Content-Type': 'application/json' },
                body: JSON.stringify({ cv, jobs }),
            });
            const evaluate = async () => {
                const response = await post();
                assert.equal(response.status, 200);
                return await response.json() as Evaluation;
            };
            const empty = await evaluate();
            assert.equal(empty.catalogStatus, 'consulted');
            assert.ok(empty.results.flatMap(result => result.recommendations)
                .every(item => item.catalogMatch === 'not_found' && item.courses.length === 0));

            const skillNames = ['Docker', 'SQL', 'Java', 'C', 'Gestión', 'Gestion', 'Sin cursos', '[TEST] interna', 'CI  CD'];
            const { rows: skills } = await owner.query<{ id: number; name: string }>(
                'INSERT INTO public.skills (name) SELECT unnest($1::text[]) RETURNING id, name', [skillNames],
            );
            const skillIds = new Map(skills.map(({ id, name }) => [name, id]));
            // Los registros elegibles se crean solo en esta base desechable.
            const courses = [
                { id: 1, skills: ['Docker'], title: '[demo] excluido' },
                { id: 2, skills: ['Docker'], platform: '[TEST] excluida' },
                { id: 3, skills: ['Docker'], url: 'https://example.org/cvexpert-demo/sql' },
                { id: 4, skills: ['Docker', '[TEST] interna'] },
                { id: 5, skills: ['Docker'], url: 'https://example.org/test/course-a' },
                { id: 6, skills: ['Docker'], logo: 'https://example.org/test/logo.png' },
                { id: 10, skills: ['Docker'] },
                { id: 20, skills: ['Docker', 'SQL'], title: 'Contenedores y consultas' },
                { id: 30, skills: ['Docker'] },
                { id: 40, skills: ['Docker'] },
                { id: 50, skills: ['Docker'] },
                { id: 60, skills: ['Docker'] },
                { id: 70, skills: ['SQL'] },
                { id: 80, skills: ['Java', 'C'], title: 'JavaScript y C++ sin asociación' },
                { id: 90, skills: ['Gestión'] },
                { id: 100, skills: ['CI  CD'] },
            ];
            for (const { id, skills: names, title, platform, url: courseUrl, logo } of courses) {
                await owner.query(`INSERT INTO public.courses (id, title, platform, url, is_paid, duration_hours, logo_url)
                    OVERRIDING SYSTEM VALUE VALUES ($1, $2, $3, $4, false, NULL, $5)`,
                [id, title ?? `Curso ${id}`, platform ?? 'Catálogo local', courseUrl ?? `https://fixture.catalog.local/${id}`, logo ?? null]);
                await owner.query('INSERT INTO public.course_skills (course_id, skill_id) SELECT $1, unnest($2::integer[])',
                    [id, names.map(name => skillIds.get(name))]);
            }

            const result = await evaluate();
            assert.equal(result.catalogStatus, 'consulted');
            assert.deepEqual(result.results.map(offer => offer.recommendations.map(item =>
                [item.skillName, item.catalogMatch, item.courses.map(course => course.id)])), [[
                ['Docker', 'matched', ['10', '20', '30', '40', '50']],
                ['sql', 'matched', ['20', '70']],
                ['JavaScript', 'not_found', []],
                ['C++', 'not_found', []],
                ['Gestión', 'ambiguous', []],
                ['CI CD', 'matched', ['100']],
                ['Sin cursos', 'matched', []],
                [attack, 'not_found', []],
            ], [['docker', 'matched', ['10', '20', '30', '40', '50']]]]);
            const shared = result.results[0]!.recommendations[0]!.courses[1]!;
            assert.deepEqual(shared, {
                id: '20', title: 'Contenedores y consultas', platform: 'Catálogo local', url: 'https://fixture.catalog.local/20',
                logoUrl: null, durationHours: null, isPaid: false, skills: ['Docker', 'SQL'],
            });

            await owner.query('REVOKE SELECT ON public.courses FROM cvexpert_brecha_app');
            const unavailable = await post();
            assert.equal(unavailable.status, 503);
            assert.deepEqual(await unavailable.json(), { error: 'CATALOG_UNAVAILABLE', message: 'El catálogo no está disponible temporalmente.' });
            assert.equal((await post('evaluate')).status, 200);
            await owner.query('GRANT SELECT ON public.courses TO cvexpert_brecha_app');
            assert.deepEqual(await evaluate(), result);
        });
    } finally {
        if (!reader.ended) await reader.end();
    }
}));
