import assert from 'node:assert/strict';
import { test } from 'node:test';
import { Pool } from 'pg';
import { getDatabaseConfig } from '../../src/db/config.js';
import { migrate } from '../../src/db/migrate.js';
import { inTransaction } from '../../src/db/transaction.js';
import { InvalidAnalysisInput } from '../../src/domain/skills-gap.js';
import { createPostgresSkillsGapRepository } from '../../src/repositories/skills-gap.repository.js';
import { AnalysisUnavailable, createSkillsGapAnalysisService } from '../../src/services/skills-gap-analysis.service.js';
import { withTestDatabase } from './helpers/test-database.js';

const scale = { key: 'test-only-v1', levels: [10, 30, 90] };
const users = ['SQL', 'TypeScript'].map(skillName => ({ skillName, level: 10, scaleKey: scale.key }));
const pgCode = (code: string) => (error: unknown) => !!error && typeof error === 'object' && 'code' in error && error.code === code;

test('motor con requisitos y catálogo reales en PostgreSQL 17 desechable', async t => withTestDatabase(async owner => {
    await t.test('migración versionada reproducible sin registros de mercado implícitos', async () => {
        assert.deepEqual(await migrate(owner), ['001_create_catalog.sql', '002_create_market_requirements.sql']);
        assert.deepEqual(await migrate(owner), []);
        assert.equal((await owner.query('SELECT count(*)::int AS n FROM public.market_requirements')).rows[0].n, 0);
    });
    assert.ok(process.env.PG_READONLY_PASSWORD);
    await owner.query('GRANT USAGE ON SCHEMA public TO cvexpert_brecha_app');
    await owner.query('GRANT SELECT ON public.market_requirements, public.skills, public.courses, public.course_skills TO cvexpert_brecha_app');
    const reader = new Pool({ ...getDatabaseConfig(), database: owner.options.database,
        user: 'cvexpert_brecha_app', password: process.env.PG_READONLY_PASSWORD });
    const repository = createPostgresSkillsGapRepository(() => reader);
    const service = createSkillsGapAnalysisService(repository);
    try {
        await t.test('sin datos retorna vacío y falta de mercado conserva niveles desconocidos', async () => {
            assert.equal((await service.analyze('test:market', scale, [])).status, 'empty');
            const result = await service.analyze('test:market', scale, users);
            assert.equal(result.status, 'incomplete');
            assert.equal(result.unresolved[0]?.marketLevel, null);
        });
        await inTransaction(owner, async client => {
            await client.query("INSERT INTO public.skills (name) VALUES ('SQL'), ('TypeScript'), ('Unknown'), ('NoCourses')");
            for (const [id, title, duration] of [[10, '[TEST] Multi', null], [2, '[TEST] SQL', 0], [20, '[TEST] Unlinked', 8], [30, '[DEMO] Excluded', 8]] as const) {
                await client.query(`INSERT INTO public.courses (id, title, platform, url, is_paid, duration_hours)
                    OVERRIDING SYSTEM VALUE VALUES ($1, $2, '[TEST]', $3, false, $4)`, [id, title, `https://example.org/test/${id}`, duration]);
            }
            await client.query(`INSERT INTO public.course_skills (course_id, skill_id)
                SELECT c.id, s.id FROM public.courses c CROSS JOIN public.skills s
                WHERE (c.id IN (2, 30) AND s.name = 'SQL') OR (c.id = 10 AND s.name IN ('SQL', 'TypeScript'))`);
            await client.query(`INSERT INTO public.market_requirements
                (market_key, skill_id, scale_key, required_level, source_reference, observed_at, data_kind)
                SELECT 'test:market', id, $1, CASE name WHEN 'Unknown' THEN NULL ELSE 90 END,
                    'test:reviewed-fixture', '2026-01-01T00:00:00Z', 'reference' FROM public.skills`, [scale.key]);
        });
        await t.test('snapshot sin duplicados, orden numérico, null y asignación única entre brechas', async () => {
            const snapshot = await repository.loadMarket('test:market');
            assert.deepEqual(snapshot.courses.map(c => c.id), ['2', '10', '30']);
            assert.equal(snapshot.requirements[0]?.sourceReference, 'test:reviewed-fixture');
            assert.ok(snapshot.requirements[0]?.observedAt);
            const result = await service.analyze('test:market', scale, users);
            assert.deepEqual(result.gaps.map(g => [g.skillName, g.courses.map(c => c.id)]), [['SQL', ['2', '10']], ['TypeScript', []]]);
            assert.equal(result.gaps[0]?.courses[0]?.durationHours, 0);
            assert.equal(result.gaps[0]?.courses[1]?.durationHours, null);
            assert.equal(result.gaps[0]?.courses[1]?.logoUrl, null);
            assert.equal(result.status, 'incomplete');
            assert.equal(result.unresolved.length, 2);
        });
        await t.test('sin cursos compatibles y con nivel desconocido no fabrica cursos o niveles', async () => {
            const result = await service.analyze('test:market', scale, [
                { skillName: 'NoCourses', level: 10, scaleKey: scale.key },
                { skillName: 'Unknown', level: 10, scaleKey: scale.key },
            ]);
            assert.deepEqual(result.gaps.map(g => [g.skillName, g.courses]), [['NoCourses', []]]);
            assert.equal(result.unresolved.find(r => r.skillName === 'Unknown')?.marketLevel, null);
        });
        await t.test('contextos exactos e inyección SQL no modifican la base', async () => {
            for (const key of ["test:market'; DROP TABLE public.skills; --", '%', 'TEST:MARKET']) {
                assert.deepEqual(await repository.loadMarket(key), { requirements: [], courses: [] });
            }
            assert.equal((await repository.loadMarket('test:market')).requirements.length, 4);
        });
        await t.test('restricciones de integridad y RESTRICT efectivos dentro de transacción revertida', async () => {
            const client = await owner.connect();
            try {
                await client.query('BEGIN');
                for (const [sql, code] of [
                    ["DELETE FROM public.skills WHERE name = 'NoCourses'", '23503'],
                    ["UPDATE public.market_requirements SET data_kind = 'fabricated'", '23514'],
                    ["UPDATE public.market_requirements SET market_key = ' '", '23514'],
                    ["UPDATE public.market_requirements SET source_reference = ''", '23514'],
                    ["UPDATE public.market_requirements SET skill_id = 0 WHERE skill_id = (SELECT min(skill_id) FROM public.market_requirements)", '23503'],
                    ["UPDATE public.market_requirements SET scale_key = ''", '23514'],
                    ["UPDATE public.market_requirements SET observed_at = NULL", '23502'],
                    ['INSERT INTO public.market_requirements SELECT * FROM public.market_requirements', '23505'],
                ]) {
                    await client.query('SAVEPOINT constraint_probe');
                    await assert.rejects(client.query(sql!), pgCode(code!));
                    await client.query('ROLLBACK TO SAVEPOINT constraint_probe');
                }
                assert.equal((await client.query("SELECT count(*)::int AS n FROM public.skills WHERE name='NoCourses'")).rows[0].n, 1);
            } finally { try { await client.query('ROLLBACK'); } finally { client.release(); } }
        });
        await t.test('mantenimiento separado y cambios de escala o demo nunca producen recomendaciones reales', async () => {
            await inTransaction(owner, async client => {
                await client.query(`INSERT INTO public.market_requirements
                    SELECT 'test:demo', skill_id, scale_key, required_level, source_reference, observed_at, 'demo'
                    FROM public.market_requirements WHERE market_key='test:market'`);
                await client.query(`INSERT INTO public.market_requirements
                    SELECT 'test:other-scale', skill_id, 'other-v1', required_level, source_reference, observed_at, 'reference'
                    FROM public.market_requirements WHERE market_key='test:market'`);
            });
            await assert.rejects(service.analyze('test:demo', scale, users), InvalidAnalysisInput);
            const result = await service.analyze('test:other-scale', scale, users);
            assert.deepEqual(result.gaps, []);
            assert.equal(result.unresolved.find(r => r.skillName === 'SQL')?.reason, 'SCALE_MISMATCH');
        });
        await t.test('rol HTTP requiere SELECT, sin DML, DDL, secuencias o privilegios de mantenimiento', async () => {
            const role = (await reader.query('SELECT current_user AS name, rolsuper, rolcreatedb, rolcreaterole FROM pg_roles WHERE rolname=current_user')).rows[0];
            assert.deepEqual(role, { name: 'cvexpert_brecha_app', rolsuper: false, rolcreatedb: false, rolcreaterole: false });
            for (const sql of [
                'DELETE FROM public.market_requirements', 'UPDATE public.market_requirements SET required_level=0',
                'INSERT INTO public.market_requirements SELECT * FROM public.market_requirements',
                'ALTER TABLE public.market_requirements ADD COLUMN forbidden integer',
                'SELECT * FROM public.schema_migrations', "SELECT nextval('public.skills_id_seq')",
            ]) await assert.rejects(reader.query(sql), pgCode('42501'));
            assert.equal((await service.analyze('test:market', scale, users)).gaps.length, 2);
        });
        await t.test('errores PostgreSQL no filtran SQL ni credenciales al consumidor del servicio', async () => {
            await owner.query('REVOKE SELECT ON public.market_requirements FROM cvexpert_brecha_app');
            await assert.rejects(service.analyze('test:market', scale, users), error =>
                error instanceof AnalysisUnavailable && error.message === 'El análisis no está disponible temporalmente.');
        });
    } finally {
        await repository.close();
        if (!reader.ended) await reader.end();
    }
}));
