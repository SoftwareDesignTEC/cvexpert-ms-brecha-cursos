import assert from 'node:assert/strict';
import { test } from 'node:test';
import { request } from 'node:http';
import { createApp } from '../src/app.js';
import { headers, settings } from './helpers/authenticated-app.js';
import { withHttpApp } from './helpers/http.js';
import { adaptCvSkillInput } from '../src/domain/cv-skill-v1.js';
import type { UserSkill } from '../src/domain/skills-gap.js';
import type { AnalysisSnapshot } from '../src/repositories/skills-gap.repository.js';

const skill = (level: unknown = 'beginner', skillName = 'SQL') => ({ skillName, level });
const requirement = (skillName = 'SQL', level: number | null = 4, scaleKey = 'cv-skill-v1') => ({
    skillName, level, scaleKey, sourceReference: 'test:fixture', observedAt: '2026-01-01T00:00:00Z', dataKind: 'reference' as const,
});
function fixture(market: AnalysisSnapshot = { requirements: [requirement()], courses: [] }) {
    const data = new Map<string, UserSkill[]>();
    let fail = false;
    const users = { async replace(id: string, skills: readonly UserSkill[]) { if (fail) throw Error('secret SQL password'); data.set(id, [...skills]); },
        async load(id: string) { if (fail) throw Error('secret SQL password'); return data.get(id) ?? null; }, async close() {} };
    return { data, users, market, fail() { fail = true; }, app: (configuration = { ...settings, SKILLS_GAP_MARKET_KEY: 'test:market' }) =>
        createApp('test', { async findPage() { return { items: [], totalRecords: 0 }; } }, configuration,
            users, { async loadMarket(key) { assert.equal(key, 'test:market'); if (fail) throw Error('secret SQL password'); return market; }, async close() {} }) };
}
const auth = (id = 'user-a') => ({ ...headers, 'X-User-Id': id });
const put = (url: string, body: unknown, id = 'user-a') => fetch(`${url}/skills-gap/input`, {
    method: 'PUT', headers: { ...auth(id), 'Content-Type': 'application/json' }, body: JSON.stringify(body),
});

test('adaptador ordinal completo, null y rechazo estricto de entradas y duplicados', () => {
    assert.deepEqual(adaptCvSkillInput({ skills: ['beginner', 'intermediate', 'advanced', 'expert', null].map((level, i) => skill(level, `Skill ${i}`)) }).map(s => s.level), [1, 2, 3, 4, null]);
    for (const body of [null, [], {}, { skills: [skill('unknown')] }, { skills: [skill(80)] }, { skills: [skill(), skill()] },
        { skills: [skill(), skill('expert')] }, { skills: [skill(' beginner')] }, { skills: [skill('Beginner')] },
        { skills: [skill(null, ' SQL')] }, { skills: [skill(null, '\0')] }, { skills: [], userId: 'victim' },
        { skills: [], scaleKey: 'chosen' }, { skills: [], marketKey: 'chosen' }, { skills: Array(501).fill(skill()) }]) {
        assert.throws(() => adaptCvSkillInput(body));
    }
    assert.deepEqual(adaptCvSkillInput({ skills: [] }), []);
});

test('HTTP identidad, reemplazo idempotente, aislamiento, contrato y duración desconocida', async () => {
    const f = fixture({ requirements: [requirement(), requirement('TypeScript')], courses: [{ id: '1', title: 'Test course', url: 'https://example.org/test', platform: 'Test', logoUrl: null, durationHours: null, isPaid: false, skills: ['SQL'] }] });
    await withHttpApp(f.app(), async url => {
        for (const method of ['GET', 'PUT']) {
            assert.equal((await fetch(`${url}/skills-gap${method === 'PUT' ? '/input' : ''}`, { method, headers })).status, 401);
            assert.equal((await fetch(`${url}/skills-gap${method === 'PUT' ? '/input' : ''}`, { method, headers: { 'X-User-Id': 'victim' } })).status, 403);
        }
        assert.equal((await fetch(`${url}/skills-gap`, { headers: auth() })).status, 409);
        for (const id of ['', 'user-a,user-b', 'user a', 'a'.repeat(513)]) {
            assert.equal((await fetch(`${url}/skills-gap`, { headers: auth(id) })).status, 401);
        }
        const duplicateIdentity = await new Promise<number | undefined>((resolve, reject) => {
            const req = request(`${url}/skills-gap`, { headers: { ...headers, 'X-User-Id': ['user-a', 'user-b'] } }, res => {
                res.resume(); resolve(res.statusCode);
            });
            req.on('error', reject); req.end();
        });
        assert.equal(duplicateIdentity, 401);
        for (const [body, status] of [['{', 400], [JSON.stringify({ skills: [], padding: 'a'.repeat(102400) }), 413]] as const) {
            const response = await fetch(`${url}/skills-gap/input`, {
                method: 'PUT', headers: { ...auth(), 'Content-Type': 'application/json' }, body,
            });
            assert.equal(response.status, status);
            assert.equal((await response.json() as any).error, 'INVALID_JSON_BODY');
        }
        assert.equal((await put(url, { skills: [skill()], userId: 'victim' })).status, 400);
        for (let i = 0; i < 2; i++) assert.equal((await put(url, { skills: [skill(), skill('beginner', 'TypeScript')] })).status, 204);
        assert.equal(f.data.size, 1);
        assert.match([...f.data.keys()][0], /^[a-f0-9]{64}$/);
        assert.equal((await fetch(`${url}/skills-gap`, { headers: auth('user-b') })).status, 409);
        assert.equal((await put(url, { skills: [skill('expert')] }, 'user-b')).status, 204);
        const response = await fetch(`${url}/skills-gap?pageSize=1`, { headers: auth() });
        assert.equal(response.status, 200);
        assert.equal(response.headers.get('cache-control'), 'no-store');
        assert.equal(response.headers.get('x-data-mode'), 'reference');
        const body = await response.json() as any;
        assert.equal(body.totalRecords, 2);
        assert.equal(body.items[0].userLevel, 1);
        assert.equal(body.items[0].marketLevel, 4);
        assert.equal(body.items[0].deficitSteps, 3);
        assert.equal(body.items[0].courses[0].durationHours, null);
        assert.equal(body.analysis.status, 'complete');
        assert.equal((await (await fetch(`${url}/skills-gap`, { headers: auth('user-b') })).json() as any).totalRecords, 0);
        const second = await (await fetch(`${url}/skills-gap?page=2&pageSize=1`, { headers: auth() })).json() as any;
        assert.equal(second.items[0].skillName, 'TypeScript');
        for (const page of ['3', '9007199254740991']) {
            const out = await (await fetch(`${url}/skills-gap?page=${page}`, { headers: auth() })).json() as any;
            assert.deepEqual(out.items, []); assert.equal(out.totalRecords, 2);
        }
        for (const query of ['page=0', 'page=1&page=2', 'page[]=1', 'page=1e2', 'pageSize=101', 'page=9007199254740992', 'marketKey=chosen', 'scaleKey=chosen', 'userId=victim']) {
            assert.equal((await fetch(`${url}/skills-gap?${query}`, { headers: auth() })).status, 400, query);
        }
        assert.equal((await put(url, { skills: [skill(null)] })).status, 204);
        const unknown = await (await fetch(`${url}/skills-gap`, { headers: auth() })).json() as any;
        assert.equal(unknown.analysis.status, 'incomplete');
        assert.equal(unknown.analysis.unresolved.find((r: any) => r.skillName === 'SQL').reason, 'UNKNOWN_LEVEL');
        for (const skills of [[skill('novice')], [skill(), skill()]]) assert.equal((await put(url, { skills })).status, 400);
        assert.equal((await put(url, { skills: [] })).status, 204);
        assert.deepEqual(f.data.get([...f.data.keys()][0]), []);
    });
});

test('HTTP ausencia de mercado, escala incompatible, configuración y errores de persistencia', async () => {
    for (const requirements of [[], [requirement('SQL', 4, 'other-scale')], [requirement('SQL', null)]]) {
        const f = fixture({ requirements, courses: [] });
        await withHttpApp(f.app(), async url => {
            await put(url, { skills: [skill()] });
            const response = await fetch(`${url}/skills-gap`, { headers: auth() });
            assert.equal(response.status, 200);
            const body = await response.json() as any;
            assert.deepEqual(body.items, []);
            assert.equal(body.analysis.status, 'incomplete');
            assert.equal(body.analysis.comparedSkills, 0);
            assert.equal(body.analysis.marketStatus, requirements.length === 0 ? 'missing' : 'available');
            assert.equal(body.analysis.unresolved[0].reason, requirements.length === 0 ? 'MISSING_MARKET_REQUIREMENT' : requirements[0].level === null ? 'UNKNOWN_LEVEL' : 'SCALE_MISMATCH');
        });
    }
    const f = fixture();
    const empty = fixture({ requirements: [], courses: [] });
    await withHttpApp(empty.app(), async url => {
        await put(url, { skills: [] });
        const body = await (await fetch(`${url}/skills-gap`, { headers: auth() })).json() as any;
        assert.equal(body.analysis.status, 'empty');
        assert.equal(body.analysis.marketStatus, 'missing');
    });
    await withHttpApp(f.app({ ...settings, SKILLS_GAP_MARKET_KEY: '' }), async url => {
        assert.equal((await fetch(`${url}/skills-gap`, { headers: auth() })).status, 503);
    });
    await withHttpApp(f.app(), async url => {
        await put(url, { skills: [skill()] });
        f.fail();
        for (const response of [await put(url, { skills: [] }), await fetch(`${url}/skills-gap`, { headers: auth() })]) {
            assert.equal(response.status, 503);
            assert.doesNotMatch(await response.text(), /secret|password|SQL/);
        }
    });
    const bypass = fixture();
    await withHttpApp(bypass.app({ APIM_ALLOW_INSECURE_LOCAL: 'true' } as any), async url => {
        assert.equal((await fetch(`${url}/skills-gap`, { headers: auth() })).status, 403);
        assert.equal((await put(url, { skills: [] })).status, 403);
    });
});
