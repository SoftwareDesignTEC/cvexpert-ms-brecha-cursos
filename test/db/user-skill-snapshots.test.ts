import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { test } from 'node:test';
import { Pool } from 'pg';
import { migrate } from '../../src/db/migrate.js';
import { getDatabaseConfig } from '../../src/db/config.js';
import { createPostgresUserSkillsRepository, createPostgresSkillsGapRepository } from '../../src/repositories/skills-gap.repository.js';
import { adaptCvSkillInput } from '../../src/domain/cv-skill-v1.js';
import { withTestDatabase } from './helpers/test-database.js';
import { withHttpApp } from '../helpers/http.js';
import { headers, settings } from '../helpers/authenticated-app.js';
import { createApp } from '../../src/app.js';

const hash = (id: string) => createHash('sha256').update('skills-gap:subject:v1\0').update(id).digest('hex');
const input = (level: string | null) => adaptCvSkillInput({ skills: [{ skillName: 'SQL', level }] });
test('PostgreSQL instantáneas: permisos mínimos, concurrencia, aislamiento y HTTP real', async () => withTestDatabase(async owner => {
    await migrate(owner);
    assert.deepEqual(await migrate(owner), []);
    await owner.query('GRANT USAGE ON SCHEMA public TO cvexpert_brecha_app');
    await owner.query('GRANT SELECT ON public.skills, public.courses, public.course_skills, public.market_requirements TO cvexpert_brecha_app');
    await owner.query('GRANT SELECT, INSERT, UPDATE ON public.user_skill_snapshots TO cvexpert_brecha_app');
    const pool = new Pool({ ...getDatabaseConfig(), database: owner.options.database, user: 'cvexpert_brecha_app', password: process.env.PG_READONLY_PASSWORD });
    const users = createPostgresUserSkillsRepository(() => pool);
    try {
        assert.equal(await users.load(hash('a')), null);
        await users.replace(hash('a'), input('beginner'));
        await users.replace(hash('b'), input('expert'));
        await users.replace(hash('a'), input('beginner'));
        assert.equal((await owner.query('SELECT count(*)::int AS n FROM public.user_skill_snapshots')).rows[0].n, 2);
        await Promise.all([users.replace(hash('a'), input(null)), users.replace(hash('a'), input('advanced'))]);
        const row = await users.load(hash('a'));
        assert.equal(row?.length, 1);
        assert.ok(row?.[0].level === null || row?.[0].level === 3);
        assert.equal((await users.load(hash('b')))?.[0].level, 4);
        await users.replace(hash('a'), []);
        assert.deepEqual(await users.load(hash('a')), []);
        await assert.rejects(pool.query('DELETE FROM public.market_requirements'), { code: '42501' });
        await assert.rejects(pool.query('DELETE FROM public.user_skill_snapshots'), { code: '42501' });
        await assert.rejects(pool.query("INSERT INTO public.user_skill_snapshots VALUES ('invalid', 'cv-skill-v1', '[]')"), { code: '23514' });
        const market = createPostgresSkillsGapRepository(() => new Pool({ ...getDatabaseConfig(), database: owner.options.database,
            user: 'cvexpert_brecha_app', password: process.env.PG_READONLY_PASSWORD }));
        const app = createApp('test', { async findPage() { return { items: [], totalRecords: 0 }; } },
            { ...settings, SKILLS_GAP_MARKET_KEY: 'test:market' }, users, market);
        await withHttpApp(app, async url => {
            const auth = { ...headers, 'X-User-Id': 'http-a' };
            const put = (body: unknown) => fetch(`${url}/skills-gap/input`, { method: 'PUT', headers: { ...auth, 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
            assert.equal((await put({ skills: [{ skillName: 'SQL', level: 'beginner' }] })).status, 204);
            assert.equal((await put({ skills: [{ skillName: 'SQL', level: 'beginner' }, { skillName: 'SQL', level: 'expert' }] })).status, 400);
            assert.equal((await fetch(`${url}/skills-gap`, { headers })).status, 401);
            assert.equal((await fetch(`${url}/skills-gap`, { headers: { ...auth, 'X-User-Id': 'http-b' } })).status, 409);
            let result = await (await fetch(`${url}/skills-gap`, { headers: auth })).json() as any;
            assert.equal(result.analysis.status, 'incomplete');
            assert.equal(result.analysis.unresolved[0].reason, 'MISSING_MARKET_REQUIREMENT');
            await owner.query("INSERT INTO public.skills(name) VALUES ('SQL')");
            await owner.query(`INSERT INTO public.market_requirements SELECT 'test:market', id, 'cv-skill-v1', 4, 'test:fixture', CURRENT_TIMESTAMP, 'reference' FROM public.skills`);
            result = await (await fetch(`${url}/skills-gap?pageSize=1`, { headers: auth })).json() as any;
            assert.equal(result.analysis.status, 'complete');
            assert.equal(result.totalRecords, 1);
            assert.deepEqual(result.items[0].courses, []);
            result = await (await fetch(`${url}/skills-gap?page=2&pageSize=1`, { headers: auth })).json() as any;
            assert.deepEqual(result.items, []); assert.equal(result.totalRecords, 1);
            await owner.query('REVOKE SELECT ON public.market_requirements FROM cvexpert_brecha_app');
            assert.equal((await fetch(`${url}/skills-gap`, { headers: auth })).status, 503);
            await owner.query('GRANT SELECT ON public.market_requirements TO cvexpert_brecha_app');
            await owner.query('REVOKE UPDATE ON public.user_skill_snapshots FROM cvexpert_brecha_app');
            assert.equal((await put({ skills: [] })).status, 503);
            assert.equal((await users.load(hash('http-a')))?.[0].level, 1);
            await owner.query('REVOKE SELECT ON public.user_skill_snapshots FROM cvexpert_brecha_app');
            const failed = await fetch(`${url}/skills-gap`, { headers: auth });
            assert.equal(failed.status, 503);
            assert.doesNotMatch(await failed.text(), /SELECT|password|permission/);
        });
    } finally { if (!pool.ended) await users.close(); }
}));
