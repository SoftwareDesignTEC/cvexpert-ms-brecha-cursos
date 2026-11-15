import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { reconcile } from '../scripts/course-sync/reconcile.js';
import { canonicalUrl } from '../scripts/course-sync/validation.js';
import { planDiscoveryQuery } from '../scripts/course-sync/worker.js';
import { runSyncDemo } from '../scripts/sync-courses.js';
import { testCandidate as candidate, testRun as run, testSnapshot as empty, testTime } from './fixtures/course-sync.test.js';
import type { Snapshot } from '../scripts/course-sync/model.js';
import type { CourseCandidate } from '../scripts/course-discovery/model.js';

function existing(): Snapshot {
    const snapshot = reconcile(empty(), run()).next;
    snapshot.checkpoints = {};
    snapshot.courses[0]!.internalId = 'TEST-existing-42';
    snapshot.courses[0]!.publication = 'published';
    return snapshot;
}
const day = (n: number) => `2026-11-${15 + n}T12:00:00.000Z`;

test('TEST: inserción propuesta, desconocidos y entrada inmutable', () => {
    const before = empty(), input = run(), copy = structuredClone(input);
    const plan = reconcile(before, input);
    assert.equal(plan.actions[0]!.kind, 'insert');
    assert.equal(plan.actions[0]!.decision, 'human_review');
    assert.equal(plan.next.courses[0]!.publication, 'draft');
    assert.equal(plan.next.courses[0]!.course.isPaid, null);
    assert.equal(plan.next.courses[0]!.course.durationMinutes, null);
    assert.deepEqual(before, empty()); assert.deepEqual(input, copy);
});
test('TEST: duplicados exactos se colapsan; discrepancias no eligen un ganador', () => {
    const exact = reconcile(empty(), run({ candidates: [candidate(), candidate()] }));
    assert.equal(exact.next.courses.length, 1);
    assert.ok(exact.actions.some(a => a.kind === 'duplicate'));
    const conflict = reconcile(existing(), run({ candidates: [candidate(), candidate({ title: '[TEST] Conflicto' })] }));
    assert.equal(conflict.actions[0]!.kind, 'ambiguous');
    assert.equal(conflict.absenceEligible, false);
    assert.deepEqual(conflict.next.courses, existing().courses);
});
test('TEST: repetición y días posteriores son idempotentes sin duplicados', () => {
    const first = reconcile(empty(), run());
    const replay = reconcile(first.next, run());
    assert.equal(replay.skipped, true); assert.deepEqual(replay.next, first.next);
    const laterCandidate = candidate({ lastSeenAt: day(1) });
    laterCandidate.evidence[0]!.queriedAt = day(1);
    const later = reconcile(first.next, run({ runId: 'TEST-next', observedAt: day(1), candidates: [laterCandidate] }));
    assert.equal(later.actions[0]!.kind, 'unchanged'); assert.equal(later.next.courses.length, 1);
    assert.equal(later.next.courses[0]!.internalId, first.next.courses[0]!.internalId);
    assert.equal(reconcile(later.next, run()).skipped, true);
});
test('TEST: actualización de título/duración conserva ID interno y publicación', () => {
    const plan = reconcile(existing(), run({ candidates: [candidate({ title: '[TEST] Título revisado', durationMinutes: 90 })] }));
    assert.equal(plan.actions[0]!.kind, 'update');
    assert.equal(plan.next.courses[0]!.internalId, 'TEST-existing-42');
    assert.equal(plan.next.courses[0]!.course.durationMinutes, 90);
    assert.equal(plan.next.courses[0]!.publication, 'published');
});
test('TEST: primera/segunda ausencia conservan curso; tercera propone revisión sin DELETE', () => {
    let state = existing();
    for (let n = 1; n <= 3; n++) {
        const input = run({ runId: `TEST-missing-${n}`, observedAt: day(n), candidates: [] });
        const plan = reconcile(state, input);
        assert.equal(plan.next.courses[0]!.missingCount, n);
        assert.equal(plan.actions[0]!.kind, n === 3 ? 'deactivation_candidate' : 'missing');
        assert.equal(plan.next.courses[0]!.publication, 'published');
        assert.deepEqual(reconcile(plan.next, input).next, plan.next);
        state = plan.next;
    }
});
test('TEST: errores, cobertura parcial, cuotas, páginas y registros inválidos no cuentan ausencias', () => {
    for (const patch of [{ status: 'failed' as const }, { status: 'partial' as const }, { valid: false },
        { quotaLimited: true }, { missingPages: true }, { errors: ['TEST HTTP failure'] }, { scope: 'query' as const },
        { candidates: [{}] }]) {
        const before = existing(); before.courses[0]!.missingCount = 1;
        const plan = reconcile(before, run({ candidates: [], ...patch }));
        assert.equal(plan.absenceEligible, false); assert.equal(plan.next.courses[0]!.missingCount, 1);
    }
});
test('TEST: observación válida restablece ausencias incluso en recorrido parcial', () => {
    const before = existing(); before.courses[0]!.missingCount = 2;
    assert.equal(reconcile(before, run({ status: 'partial' })).next.courses[0]!.missingCount, 0);
});
test('TEST: retirada explícita requiere revisión; indisponibilidad no equivale a retirada', () => {
    assert.equal(reconcile(existing(), run({ candidates: [candidate({ availability: 'withdrawn' })] })).actions[0]!.kind, 'withdrawn');
    assert.equal(reconcile(existing(), run({ candidates: [candidate({ availability: 'unavailable' })] })).actions[0]!.kind, 'update');
});
test('TEST: retirada masiva bloquea ausencias y bajas explícitas', () => {
    const state = existing();
    state.courses = Array.from({ length: 4 }, (_, i) => ({ ...structuredClone(state.courses[0]!), internalId: `TEST-${i}`,
        course: candidate({ externalId: `TEST-${i}`, canonicalUrl: `https://example.org/TEST/${i}` }) }));
    for (const candidates of [[], state.courses.map(r => ({ ...r.course, availability: 'withdrawn' as const }))]) {
        const plan = reconcile(state, run({ candidates }));
        assert.equal(plan.massWithdrawalBlocked, true); assert.equal(plan.absenceEligible, false);
        assert.deepEqual(plan.next.courses, state.courses);
    }
});
test('TEST: convocatoria INA retirada conserva curso permanente y otras convocatorias', () => {
    const state = existing();
    state.courses[0]!.course.offerings = [{ externalId: 'TEST-INA-1', availability: 'available', startsAt: null, endsAt: null, modality: 'unknown', geography: null }];
    const plan = reconcile(state, run({ candidates: [candidate({ offerings: [
        { externalId: 'TEST-INA-1', availability: 'withdrawn', startsAt: null, endsAt: null, modality: 'unknown', geography: null },
        { externalId: 'TEST-INA-2', availability: 'available', startsAt: null, endsAt: null, modality: 'presential',
            geography: { country: '[TEST] País', region: '[TEST] Región', locality: '[TEST] Sede' } }] })] }));
    assert.equal(plan.actions[0]!.kind, 'update');
    assert.equal(plan.next.courses[0]!.course.availability, 'unknown');
    assert.equal(plan.next.courses[0]!.course.offerings.length, 2);
    const laterCandidate = candidate({ lastSeenAt: day(1) }); laterCandidate.evidence[0]!.queriedAt = day(1);
    const omitted = reconcile(plan.next, run({ runId: 'TEST-offerings-next', observedAt: day(1), candidates: [laterCandidate] }));
    assert.equal(omitted.actions[0]!.kind, 'unchanged');
    assert.equal(omitted.next.courses[0]!.course.offerings.length, 2);
});
test('TEST: manuales protegidos ante cambios, ausencia, URL coincidente y retirada', () => {
    const state = existing(); state.courses[0]!.origin = 'manual';
    for (const candidates of [[], [candidate({ title: '[TEST] Cambio' })], [candidate({ availability: 'withdrawn' })],
        [candidate({ externalId: 'TEST-other' })]]) {
        assert.deepEqual(reconcile(state, run({ candidates })).next.courses, state.courses);
    }
});
test('TEST: identidad por URL sin ID, URL modificada con ID, nunca por título', () => {
    const noId = reconcile(empty(), run({ candidates: [candidate({ externalId: null })] }));
    const observed = reconcile({ ...noId.next, checkpoints: {} }, run({ candidates: [candidate({ externalId: null })] }));
    assert.equal(observed.actions[0]!.kind, 'unchanged');
    const changedUrl = reconcile(existing(), run({ candidates: [candidate({ canonicalUrl: 'https://example.org/TEST/new' })] }));
    assert.equal(changedUrl.actions[0]!.kind, 'update');
    const sameTitle = reconcile(existing(), run({ candidates: [candidate({ externalId: 'TEST-other', canonicalUrl: 'https://example.org/TEST/other' })] }));
    assert.equal(sameTitle.next.courses.length, 2);
    const collision = reconcile(existing(), run({ candidates: [candidate({ externalId: 'TEST-other' })] }));
    assert.equal(collision.actions[0]!.kind, 'ambiguous'); assert.equal(collision.absenceEligible, false);
});
test('TEST: URLs inválidas y datos incompletos quedan para revisión sin inventar valores', () => {
    for (const url of ['javascript:alert(1)', 'http://example.org/TEST', 'https://user@example.org/TEST',
        'https://@example.org/TEST', 'https://example.org/TEST#fragment', 'https://example.org/%0a', 'https://example.org/%zz']) {
        assert.throws(() => canonicalUrl(url));
        assert.equal(reconcile(empty(), run({ candidates: [candidate({ canonicalUrl: url })] })).actions[0]!.kind, 'invalid');
    }
    for (const patch of [{ title: '' }, { externalId: undefined }, { isPaid: undefined }, { durationMinutes: -1 },
        { evidence: [] }, { lastSeenAt: '2026-02-30T00:00:00.000Z' }, { sourceId: 'TEST-other' }, { language: undefined }]) {
        assert.equal(reconcile(empty(), run({ candidates: [{ ...candidate(), ...patch }] })).actions[0]!.kind, 'invalid');
    }
});
test('TEST: catálogo ambiguo previo bloquea ausencias aun sin resultados', () => {
    const state = existing();
    state.courses.push({ ...structuredClone(state.courses[0]!), internalId: 'TEST-collision' });
    const plan = reconcile(state, run({ candidates: [] }));
    assert.equal(plan.absenceEligible, false);
    assert.ok(plan.actions.every(a => a.kind === 'ambiguous'));
    assert.ok(plan.next.courses.every(c => c.missingCount === 0));
});
test('TEST: sin filtros sectoriales; proveedores separados no comparten ausencias', () => {
    const sectors = ['Idiomas', 'Administración', 'Turismo', 'Agricultura', 'Salud', 'Educación', 'Manufactura', 'Emprendimiento'];
    const courses = sectors.map((s, i) => candidate({ externalId: `TEST-sector-${i}`, canonicalUrl: `https://example.org/TEST/sector-${i}`,
        title: `[TEST] ${s}`, associatedSkills: [`[TEST] ${s}`] }));
    const first = reconcile(empty(), run({ candidates: courses }));
    assert.equal(first.next.courses.length, sectors.length);
    const other = reconcile(first.next, run({ sourceId: 'TEST-other-provider', candidates: [] }));
    assert.deepEqual(other.next.courses, first.next.courses);
});
test('TEST: puerto existente soporta fallo y búsqueda vacía sin autorizar ausencias', async () => {
    for (const search of [async () => { throw new Error('TEST failure'); }, async () => ({ candidates: [], rejected: 0, truncated: false })]) {
        const plan = await planDiscoveryQuery({ name: 'TEST-provider', search }, { skill: '[TEST] Turismo' },
            { load: async () => existing() }, { runId: 'TEST-worker', observedAt: testTime });
        assert.equal(plan.absenceEligible, false); assert.equal(plan.next.courses[0]!.missingCount, 0);
    }
    const c = candidate();
    const discovered: CourseCandidate = { ...c, source: c.sourceId, queriedAt: c.lastSeenAt,
        url: c.canonicalUrl, levels: [], reviewReasons: ['TEST_REVIEW_REQUIRED'] };
    const plan = await planDiscoveryQuery({ name: 'TEST-provider', search: async () => ({ candidates: [discovered], rejected: 0, truncated: false }) },
        { skill: '[TEST] Agricultura' }, { load: async () => existing() }, { runId: 'TEST-success', observedAt: testTime });
    assert.equal(plan.actions[0]!.kind, 'unchanged');
    assert.equal(plan.next.courses[0]!.internalId, 'TEST-existing-42');
    assert.equal(plan.absenceEligible, false);
});
test('TEST: observaciones cacheadas no restablecen ausencias y fechas futuras se rechazan', () => {
    const state = existing();
    state.checkpoints['TEST-provider'] = { runId: 'TEST-previous', observedAt: testTime };
    state.courses[0]!.missingCount = 2;
    const stale = reconcile(state, run({ runId: 'TEST-stale', observedAt: day(1) }));
    assert.equal(stale.actions[0]!.kind, 'invalid');
    assert.equal(stale.absenceEligible, false);
    assert.equal(stale.next.courses[0]!.missingCount, 2);
    const future = candidate({ lastSeenAt: day(1) }); future.evidence[0]!.queriedAt = day(1);
    assert.equal(reconcile(empty(), run({ candidates: [future] })).actions[0]!.kind, 'invalid');
});
test('TEST: CLI exclusivamente fixture rechaza live/apply/archivos y es determinista', () => {
    for (const args of [['--apply'], ['--live'], ['--file', 'TEST.json'], ['--fixture', '--fixture']]) assert.throws(() => runSyncDemo(args));
    assert.deepEqual(runSyncDemo([]), runSyncDemo(['--dry-run', '--fixture']));
});
test('TEST: demostración bajo permisos Node sin red, procesos hijos ni escrituras', () => {
    // Native TypeScript transform avoids tsx/esbuild's worker and child process needs.
    const script = `import { registerHooks } from 'node:module';
        registerHooks({ resolve(specifier, context, next) {
            try { return next(specifier, context); }
            catch (error) { if (specifier.endsWith('.js') && specifier.startsWith('.'))
                return next(specifier.slice(0, -3) + '.ts', context); throw error; }
        }});
        const { runSyncDemo } = await import('./scripts/sync-courses.ts');
        console.log(JSON.stringify(runSyncDemo(['--dry-run', '--fixture'])));`;
    const result = spawnSync(process.execPath, ['--permission', '--allow-fs-read=*', '--experimental-transform-types',
        '--input-type=module', '--eval', script], { encoding: 'utf8', env: { PATH: process.env.PATH, SystemRoot: process.env.SystemRoot } });
    assert.equal(result.status, 0, result.stderr);
    const report = JSON.parse(result.stdout);
    assert.equal(report.databaseAccess, false); assert.equal(report.publicationApproved, false);
    assert.equal(report.dataSource, 'TEST_SYNTHETIC_ONLY');
    assert.match(report.next.courses[0].course.title, /\[TEST\]/);
    // No production composition imports the worker; existing server remains independent.
    assert.doesNotMatch(readFileSync(new URL('../src/server.ts', import.meta.url), 'utf8'), /course-sync|sync-courses/);
});
