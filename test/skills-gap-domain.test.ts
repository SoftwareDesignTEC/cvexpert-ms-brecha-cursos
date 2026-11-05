import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { Pool } from 'pg';
import { analyzeSkillsGap, InvalidAnalysisInput, type MarketRequirement, type UserSkill } from '../src/domain/skills-gap.js';
import type { CatalogCourse } from '../src/models/courses.js';
import { createPostgresSkillsGapRepository } from '../src/repositories/skills-gap.repository.js';
import { AnalysisUnavailable, createSkillsGapAnalysisService } from '../src/services/skills-gap-analysis.service.js';

// Escala EXCLUSIVA del fixture; sus valores no son un requisito del producto.
const scale = { key: 'test-ordinal-v1', levels: [10, 30, 90] };
const user = (skillName = 'SQL', level: number | null = 10, scaleKey: string | null = scale.key): UserSkill => ({ skillName, level, scaleKey });
const requirement = (skillName = 'SQL', level: number | null = 90, scaleKey: string | null = scale.key): MarketRequirement => ({
    ...user(skillName, level, scaleKey), sourceReference: 'test:market-fixture', observedAt: '2026-01-01T00:00:00Z', dataKind: 'reference',
});
const course = (id: string, skills = ['SQL'], durationHours: number | null = null): CatalogCourse => ({
    id, title: '[TEST] Curso', platform: '[TEST]', url: `https://example.org/test/${id}`,
    isPaid: false, logoUrl: null, durationHours, skills,
});
const analyze = (userSkills: UserSkill[] = [user()], requirements: MarketRequirement[] = [requirement()], courses: CatalogCourse[] = []) =>
    analyzeSkillsGap({ scale, userSkills, requirements, courses });

test('vacío, usuarios ausentes y mercado ausente nunca fabrican nivel cero', () => {
    assert.deepEqual(analyze([], []), { gaps: [], unresolved: [], comparedSkills: 0, status: 'empty' });
    for (const [users, market, reason] of [
        [[], [requirement()], 'MISSING_USER_SKILL'], [[user()], [], 'MISSING_MARKET_REQUIREMENT'],
        [[user('SQL', null)], [requirement()], 'UNKNOWN_LEVEL'],
        [[user()], [requirement('SQL', null)], 'UNKNOWN_LEVEL'],
        [[user('SQL', 10, null)], [requirement()], 'UNKNOWN_SCALE'],
        [[user()], [requirement('SQL', 90, null)], 'UNKNOWN_SCALE'],
        [[user('SQL', 10, 'other-v1')], [requirement()], 'SCALE_MISMATCH'],
        [[user()], [requirement('SQL', 90, 'other-v1')], 'SCALE_MISMATCH'],
    ] as const) {
        const result = analyze([...users], [...market]);
        assert.equal(result.status, 'incomplete');
        assert.equal(result.comparedSkills, 0);
        assert.deepEqual(result.gaps, []);
        assert.equal(result.unresolved[0]?.reason, reason);
    }
    assert.equal(analyze([], [requirement()]).unresolved[0]?.userLevel, null);
    assert.equal(analyze([user()], []).unresolved[0]?.marketLevel, null);
});

test('compara posiciones ordinales, no porcentajes, y conserva empates y niveles suficientes', () => {
    const result = analyze([user('B'), user('A'), user('C', 90), user('D', 30)],
        [requirement('D', 10), requirement('C'), requirement('A'), requirement('B')]);
    assert.equal(result.status, 'complete');
    assert.equal(result.comparedSkills, 4);
    assert.deepEqual(result.gaps.map(g => [g.skillName, g.userLevel, g.marketLevel, g.deficitSteps]),
        [['A', 10, 90, 2], ['B', 10, 90, 2]]);
    assert.deepEqual(analyze([user('A', 30), user('B')], [requirement('A'), requirement('B')]).gaps.map(g => g.skillName), ['B', 'A']);
});

test('parcial conserva casos sin evaluar y coincidencia de nombres es exacta', () => {
    const result = analyze([user(), user('sql')], [requirement(), requirement('Other')]);
    assert.equal(result.status, 'incomplete');
    assert.equal(result.comparedSkills, 1);
    assert.equal(result.gaps.length, 1);
    assert.deepEqual(result.unresolved.map(i => i.skillName), ['Other', 'sql']);
});

test('rechaza niveles inválidos, escalas ambiguas, procedencia inválida y conflictos', () => {
    for (const level of [NaN, Infinity, 1.5, 2147483648, -2147483649, 20]) {
        assert.throws(() => analyze([user('SQL', level)]), InvalidAnalysisInput);
        assert.throws(() => analyze([user()], [requirement('SQL', level)]), InvalidAnalysisInput);
    }
    for (const levels of [[], [10], [10, 10], [10, NaN], [10, 0.5]]) {
        assert.throws(() => analyzeSkillsGap({ scale: { key: 'x', levels }, userSkills: [], requirements: [], courses: [] }), InvalidAnalysisInput);
    }
    assert.throws(() => analyze([user(), user('SQL', 30)]), InvalidAnalysisInput);
    assert.throws(() => analyze([user()], [requirement(), requirement('SQL', 30)]), InvalidAnalysisInput);
    assert.throws(() => analyze([user()], [requirement(), { ...requirement(), sourceReference: 'test:conflict' }]), InvalidAnalysisInput);
    assert.throws(() => analyze([user(' SQL')]), InvalidAnalysisInput);
    assert.throws(() => analyze([user('SQL\0')]), InvalidAnalysisInput);
    for (const patch of [{ dataKind: 'demo' as const }, { observedAt: 'invalid' }, { sourceReference: '' }]) {
        assert.throws(() => analyze([user()], [{ ...requirement(), ...patch }]), InvalidAnalysisInput);
    }
    assert.deepEqual(analyze([user(), user()], [requirement(), requirement()]), analyze());
});

test('la definición explícita de escala determina el orden, sin deducir porcentajes de los códigos', () => {
    const result = analyzeSkillsGap({ scale: { key: scale.key, levels: [90, 30, 10] },
        userSkills: [user('SQL', 90)], requirements: [requirement('SQL', 10)], courses: [] });
    assert.equal(result.gaps[0]?.deficitSteps, 2);
    assert.equal(result.gaps[0]?.userLevel, 90);
    assert.equal(result.gaps[0]?.marketLevel, 10);
});

test('selección exacta, globalmente única, ID numérico, nulos y orden independiente de entrada', () => {
    const users = [user('B', 30), user('A')], market = [requirement('B'), requirement('A')];
    const courses = [course('10', ['A', 'B']), course('2', ['A', 'A']), course('1', []), course('30', ['B'], 0),
        course('40', ['Other']), course('50', ['A'])];
    courses[5]!.title = '[DEMO] Ficticio';
    const before = structuredClone({ users, market, courses });
    const result = analyze(users, market, courses);
    assert.deepEqual(result.gaps.map(g => [g.skillName, g.courses.map(c => c.id)]), [['A', ['2', '10']], ['B', ['30']]]);
    assert.equal(result.gaps[0]!.courses[0]!.durationHours, null);
    assert.equal(result.gaps[0]!.courses[0]!.logoUrl, null);
    assert.equal(result.gaps[1]!.courses[0]!.durationHours, 0);
    assert.deepEqual(analyze(users.toReversed(), market.toReversed(), [...courses, courses[0]!].toReversed()), result);
    assert.deepEqual({ users, market, courses }, before);
    assert.deepEqual(analyze().gaps[0]?.courses, []);
    assert.deepEqual(analyze([user('SQL', 90)], [requirement()], [course('1')]).gaps, []);
    assert.throws(() => analyze([user()], [requirement()], [course('2'), { ...course('2'), title: 'Conflict' }]), InvalidAnalysisInput);
    for (const id of ['demo', '0', '-1', '01', '2147483648']) assert.throws(() => analyze([user()], [requirement()], [course(id)]), InvalidAnalysisInput);
    for (const value of [-1, 0.5, NaN]) assert.throws(() => analyze([user()], [requirement()], [course('1', ['SQL'], value)]), InvalidAnalysisInput);
});

test('servicio utiliza snapshot persistente, es perezoso y oculta errores de conexión', async () => {
    let calls = 0, ended = false;
    const payload = "x'; DROP TABLE public.skills; --";
    const fakePool = {
        async query(sql: string, values: unknown[]) {
            calls++; assert.ok(!sql.includes(payload)); assert.deepEqual(values, [payload]);
            return { rows: [{ requirements: [requirement()], courses: [course('2')] }] };
        },
        async end() { ended = true; },
    } as unknown as Pool;
    const repo = createPostgresSkillsGapRepository(() => fakePool);
    assert.equal(calls, 0);
    assert.equal((await createSkillsGapAnalysisService(repo).analyze(payload, scale, [user()])).gaps[0]?.courses[0]?.id, '2');
    assert.equal(calls, 1);
    await repo.close(); assert.equal(ended, true);
    const failure = createSkillsGapAnalysisService({ async loadMarket() { throw new Error('password query internal'); }, async close() {} });
    await assert.rejects(failure.analyze('x', scale, [user()]), error => error instanceof AnalysisUnavailable && !error.message.includes('password'));
    await assert.rejects(failure.analyze('', scale, [user()]), InvalidAnalysisInput);
    const disconnected = createSkillsGapAnalysisService(createPostgresSkillsGapRepository(() => { throw new Error('PGPASSWORD=secret'); }));
    await assert.rejects(disconnected.analyze('x', scale, []), AnalysisUnavailable);
});
