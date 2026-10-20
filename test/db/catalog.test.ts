import 'dotenv/config';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';
import { migrate } from '../../src/db/migrate.js';
import { withTestDatabase } from './helpers/test-database.js';

test('integridad del catálogo en PostgreSQL aislado (fixtures revertidos)', async t => withTestDatabase(async pool => {
    await migrate(pool);
    // El finally de withTestDatabase cierra el pool incluso si connect rechaza.
    const client = await pool.connect();
    try {
        await client.query('BEGIN');
        const suffix = randomUUID();
        const skill = await client.query<{ id: number }>(
            'INSERT INTO public.skills (name) VALUES ($1) RETURNING id', [`[TEST DEMO] ${suffix}`]);
        const course = await client.query<{ id: number }>(
            `INSERT INTO public.courses (title, platform, url, is_paid)
             VALUES ($1, $2, $3, false) RETURNING id`,
            [`[TEST DEMO] ${suffix}`, '[TEST DEMO]', `https://example.org/test/${suffix}`]);
        const skillId = skill.rows[0]!.id;
        const courseId = course.rows[0]!.id;
        await client.query('INSERT INTO public.course_skills VALUES ($1, $2)', [courseId, skillId]);

        async function expectConstraint(sql: string, values: unknown[], code: string) {
            await client.query('SAVEPOINT invalid_fixture');
            try {
                await assert.rejects(client.query(sql, values), (error: unknown) =>
                    !!error && typeof error === 'object' && 'code' in error && error.code === code);
            } finally {
                await client.query('ROLLBACK TO SAVEPOINT invalid_fixture');
                await client.query('RELEASE SAVEPOINT invalid_fixture');
            }
        }

        await t.test('asociación muchos a muchos consultable y opcionales NULL', async () => {
            const result = await client.query(`SELECT s.name, c.duration_hours, c.logo_url
                FROM public.courses c JOIN public.course_skills cs ON cs.course_id = c.id
                JOIN public.skills s ON s.id = cs.skill_id WHERE c.id = $1`, [courseId]);
            assert.deepEqual(result.rows, [{ name: `[TEST DEMO] ${suffix}`, duration_hours: null, logo_url: null }]);
        });
        await t.test('impide asociaciones duplicadas', () => expectConstraint(
            'INSERT INTO public.course_skills VALUES ($1, $2)', [courseId, skillId], '23505'));
        await t.test('impide referencias a habilidades inexistentes', () => expectConstraint(
            'INSERT INTO public.course_skills VALUES ($1, 0)', [courseId], '23503'));
        await t.test('impide referencias a cursos inexistentes', () => expectConstraint(
            'INSERT INTO public.course_skills VALUES (0, $1)', [skillId], '23503'));
        await t.test('impide nombres duplicados', () => expectConstraint(
            'INSERT INTO public.skills (name) VALUES ($1)', [`[TEST DEMO] ${suffix}`], '23505'));
        await t.test('rechaza nombres vacíos y NULL', async () => {
            await expectConstraint("INSERT INTO public.skills (name) VALUES ('   ')", [], '23514');
            await expectConstraint('INSERT INTO public.skills (name) VALUES (NULL)', [], '23502');
        });
        await t.test('rechaza duración negativa y URL inválida', async () => {
            await expectConstraint('UPDATE public.courses SET duration_hours = -1 WHERE id = $1', [courseId], '23514');
            await expectConstraint("UPDATE public.courses SET url = 'invalid' WHERE id = $1", [courseId], '23514');
        });
        await t.test('RESTRICT impide borrar una habilidad asociada y conserva la asociación', async () => {
            await expectConstraint('DELETE FROM public.skills WHERE id = $1', [skillId], '23503');
            assert.equal((await client.query('SELECT id FROM public.skills WHERE id = $1', [skillId])).rowCount, 1);
            assert.equal((await client.query('SELECT 1 FROM public.course_skills WHERE course_id = $1 AND skill_id = $2',
                [courseId, skillId])).rowCount, 1);
        });
        await t.test('CASCADE borra asociaciones del curso, conserva la habilidad y se revierte', async () => {
            await client.query('SAVEPOINT cascade_fixture');
            try {
                const deleted = await client.query('DELETE FROM public.courses WHERE id = $1', [courseId]);
                assert.equal(deleted.rowCount, 1);
                assert.equal((await client.query('SELECT 1 FROM public.course_skills WHERE course_id = $1', [courseId])).rowCount, 0);
                assert.equal((await client.query('SELECT id FROM public.skills WHERE id = $1', [skillId])).rowCount, 1);
            } finally {
                await client.query('ROLLBACK TO SAVEPOINT cascade_fixture');
                await client.query('RELEASE SAVEPOINT cascade_fixture');
            }
            assert.equal((await client.query('SELECT id FROM public.courses WHERE id = $1', [courseId])).rowCount, 1);
            assert.equal((await client.query('SELECT 1 FROM public.course_skills WHERE course_id = $1 AND skill_id = $2',
                [courseId, skillId])).rowCount, 1);
        });
    } finally {
        try {
            await client.query('ROLLBACK');
        } finally {
            client.release();
        }
    }
}));
