import assert from 'node:assert/strict';
import { test } from 'node:test';
import { spawnSync } from 'node:child_process';
import { DiscoveryError } from '../scripts/course-discovery/model.js';
import { SaylorProvider, saylorApi, saylorCourseUrl, saylorFunction } from '../scripts/course-discovery/saylor-provider.js';
import { memoryDiscoveryStore, planSaylorDiscovery, saylorFixtureConfig } from '../scripts/course-sync/saylor.js';
import { runCourseSync, runSyncDemo } from '../scripts/sync-courses.js';
import { saylorFixture, saylorTestSnapshot, saylorTestTime } from './fixtures/saylor.test.js';

const now = () => Date.parse(saylorTestTime);
const query = { skill: '[TEST] Administración', categoryId: 0 };
const config = () => saylorFixtureConfig([query]);
const json = (body: unknown) => new Response(JSON.stringify(body), { headers: { 'content-type': 'application/json' } });
const provider = (body: unknown = saylorFixture) => new SaylorProvider({ mode: 'fixture' }, async () => json(body), now);
const search = (p = provider()) => p.search(query, async () => {});
const code = (expected: string) => (error: unknown) => error instanceof DiscoveryError && error.code === expected;
const plan = (p = provider(), snapshot = saylorTestSnapshot(), configuration = config(), store = memoryDiscoveryStore()) =>
    planSaylorDiscovery(p, snapshot, configuration, store, 'TEST-saylor-plan', now);

test('Saylor TEST: contrato documentado, siete disciplinas y categoría separada de habilidades/idioma/nivel', async () => {
    const p = provider(), page = await search(p);
    assert.equal(page.candidates.length, 8); assert.equal(page.truncated, true);
    assert.deepEqual(p.lastBatch, { received: 8, accepted: 8, rejected: 0, duplicateIds: 1 });
    for (const c of page.candidates) {
        assert.equal(c.source, 'saylor'); assert.match(c.title, /^\[TEST\]/);
        assert.equal(c.isPaid, null); assert.equal(c.language, null); assert.equal(c.durationMinutes, null);
        assert.deepEqual(c.levels, []); assert.deepEqual(c.associatedSkills, []);
        assert.equal(c.validation, 'needs_review'); assert.equal(c.queriedAt, saylorTestTime);
        assert.match(c.evidence[0]!.subjects[0]!, /^saylor:category:9900[1-7]$/);
        assert.equal(c.evidence[0]!.summary, null);
        assert.match(c.evidence[0]!.responseSha256, /^[a-f0-9]{64}$/);
        assert.equal(c.canonicalUrl, `https://learn.saylor.org/course/view.php?id=${c.externalId}`);
    }
});
test('Saylor TEST: transporte fijo sin tokens ni destino configurable; reserva antes de solicitar', async () => {
    let reserved = false, requests = 0;
    const p = new SaylorProvider({ mode: 'fixture' }, async (input, options) => {
        requests++; assert.equal(reserved, true); assert.equal(String(input), saylorApi);
        assert.equal(options?.method, 'POST'); assert.equal(options?.redirect, 'error');
        assert.ok(options?.signal); assert.equal(new Headers(options?.headers).has('authorization'), false);
        const body = new URLSearchParams(String(options?.body));
        assert.equal(body.get('wsfunction'), saylorFunction); assert.equal(body.get('cat'), '0');
        assert.equal(body.has('wstoken'), false); return json(saylorFixture);
    }, now);
    await p.search(query, async () => { reserved = true; }); assert.equal(requests, 1);
    await assert.rejects(p.search(query, async () => { throw new DiscoveryError('QUERY_BUDGET_EXHAUSTED'); }), code('QUERY_BUDGET_EXHAUSTED'));
    assert.equal(requests, 1);
});
test('Saylor TEST: transporte real y ausencia de credenciales permanecen deshabilitados', async () => {
    let calls = 0;
    for (const mode of [undefined, 'live' as const]) {
        await assert.rejects(search(new SaylorProvider({ mode }, async () => { calls++; return json(saylorFixture); })), code('SAYLOR_LIVE_DISABLED'));
    }
    await assert.rejects(search(new SaylorProvider({ mode: 'fixture' })), code('SAYLOR_LIVE_DISABLED'));
    assert.equal(calls, 0);
});
test('Saylor TEST: URL directa estricta, sin userinfo, fragmentos, tracking, otro origen o rutas indirectas', () => {
    assert.equal(saylorCourseUrl('https://learn.saylor.org/course/view.php?id=990001'), 'https://learn.saylor.org/course/view.php?id=990001');
    for (const url of ['https://evil.test/course/view.php?id=1', 'http://learn.saylor.org/course/view.php?id=1',
        'https://learn.saylor.org:443/course/view.php?id=1', 'https://user@learn.saylor.org/course/view.php?id=1',
        'https://learn.saylor.org/course/view.php?id=1&token=TEST', 'https://learn.saylor.org/course/view.php?id=1#x',
        'https://learn.saylor.org/course/../course/view.php?id=1', 'https://learn.saylor.org/course/view.php?id=0',
        'https://learn.saylor.org/course/view.php?id=%31', 'https://learn.saylor.org/course/search.php?search=TEST']) assert.throws(() => saylorCourseUrl(url));
});
test('Saylor TEST: opcionales nulos/ausentes no se inventan, obligatorios inválidos se rechazan', async () => {
    const row = saylorFixture.courses[0]!;
    const page = await search(provider({ courses: [{ ...row, summary: null, startdate: null }, row,
        { ...row, id: null }, { ...row, id: '990001' }, { ...row, category: undefined }, { ...row, shortname: '' },
        { ...row, fullname: undefined }, { ...row, summary: 10 }, { ...row, startdate: 0 },
        { ...row, url: 'https://evil.test/TEST' }, { ...row, durationMinutes: 60 }, { ...row, lang: 'en' }, { ...row, isPaid: false }] }));
    assert.equal(page.candidates.length, 2); assert.equal(page.rejected, 11);
    assert.equal(page.candidates[0]!.durationMinutes, null);
});
test('Saylor TEST: respuestas desconocidas, excepciones Moodle y paginación no documentada no aparentan éxito vacío', async () => {
    for (const body of [[], null, {}, { value: [] }, { exception: 'TEST', message: 'TEST_PRIVATE_MARKER' },
        { courses: [], nextLink: 'https://evil.test/TEST' }, { courses: null }, { courses: [], warnings: ['TEST-partial'] }]) {
        await assert.rejects(search(provider(body)), code('INVALID_RESPONSE'));
    }
    assert.equal((await search(provider({ courses: [] }))).truncated, true);
});
test('Saylor TEST: 401/403/429/5xx y 404 con códigos seguros sin reintento ni datos sensibles', async () => {
    for (const [status, expected] of [[401, 'PROVIDER_UNAUTHORIZED'], [403, 'PROVIDER_UNAUTHORIZED'],
        [429, 'RATE_LIMITED'], [500, 'PROVIDER_UNAVAILABLE'], [503, 'PROVIDER_UNAVAILABLE'], [404, 'PROVIDER_HTTP_ERROR']] as const) {
        let calls = 0;
        const p = new SaylorProvider({ mode: 'fixture' }, async () => {
            calls++; return new Response('TEST_PRIVATE_MARKER', { status, headers: { 'retry-after': '120' } });
        }, now);
        await assert.rejects(search(p), error => {
            assert.ok(code(expected)(error)); assert.doesNotMatch(String(error), /TEST_PRIVATE_MARKER/);
            if (status === 429) assert.equal((error as DiscoveryError).retryAfterMs, 120000);
            if (status >= 500) assert.ok((error as DiscoveryError).retryAfterMs >= 300000);
            return true;
        });
        assert.equal(calls, 1);
    }
});
test('Saylor TEST: rechaza redirecciones y respuestas atribuidas a otro destino', async () => {
    for (const response of [new Response(null, { status: 302, headers: { location: 'https://evil.test' } }),
        Object.defineProperty(json(saylorFixture), 'url', { value: 'https://evil.test/TEST' }),
        Object.defineProperty(json(saylorFixture), 'redirected', { value: true })]) {
        await assert.rejects(search(new SaylorProvider({ mode: 'fixture' }, async () => response)), code('UNSAFE_REDIRECT'));
    }
});
test('Saylor TEST: timeout acota transporte y cuerpo; fallos de red no exponen detalles', async () => {
    for (const request of [async () => new Promise<Response>(() => {}),
        async () => new Response(new ReadableStream({ start() {} }), { headers: { 'content-type': 'application/json' } })]) {
        await assert.rejects(search(new SaylorProvider({ mode: 'fixture', timeoutMs: 20 }, request)), code('TIMEOUT'));
    }
    await assert.rejects(search(new SaylorProvider({ mode: 'fixture' }, async () => { throw new Error('TEST_PRIVATE_MARKER'); })), code('PROVIDER_NETWORK_ERROR'));
});
test('Saylor TEST: límites de bytes/registros y JSON/UTF-8/tipo de contenido inválidos', async () => {
    await assert.rejects(search(new SaylorProvider({ mode: 'fixture', maxResponseBytes: 20 }, async () => json(saylorFixture))), code('RESPONSE_TOO_LARGE'));
    await assert.rejects(search(new SaylorProvider({ mode: 'fixture', maxRecords: 1 }, async () => json(saylorFixture))), code('RECORD_LIMIT_EXCEEDED'));
    for (const response of [new Response('<html>TEST</html>', { headers: { 'content-type': 'text/html' } }),
        new Response('{', { headers: { 'content-type': 'application/json' } }),
        new Response(new Uint8Array([0xff]), { headers: { 'content-type': 'application/json' } })]) {
        await assert.rejects(search(new SaylorProvider({ mode: 'fixture' }, async () => response)), code('INVALID_RESPONSE'));
    }
    for (const options of [{ timeoutMs: 0 }, { timeoutMs: 30001 }, { maxResponseBytes: -1 }, { maxRecords: 1.5 }]) {
        assert.throws(() => new SaylorProvider(options), code('INVALID_CONFIG'));
    }
});
test('Saylor TEST: coordinador existente deduplica; conflictos quedan para revisión', async () => {
    const report = await plan();
    assert.equal(report.discovery.candidates.length, 7); assert.equal(report.discovery.requests, 1);
    assert.equal(report.plan.actions.filter(a => a.kind === 'insert').length, 6);
    assert.equal(report.plan.actions.filter(a => a.kind === 'update').length, 1);
    const conflict = await plan(provider({ courses: [saylorFixture.courses[0], { ...saylorFixture.courses[0], fullname: '[TEST] Título contradictorio' }] }));
    assert.equal(conflict.plan.actions[0]!.kind, 'ambiguous');
    assert.equal(conflict.plan.absenceEligible, false);
});
test('Saylor TEST: cambios de título/duración desconocida y URL conservan identidad y publicación', async () => {
    const state = saylorTestSnapshot();
    state.courses[0]!.course.durationMinutes = 120;
    state.courses[0]!.course.canonicalUrl = 'https://learn.saylor.org/course/TEST-previous-link';
    const before = structuredClone(state), report = await plan(provider(), state);
    const updated = report.plan.next.courses.find(c => c.internalId === 'TEST-saylor-existing')!;
    assert.equal(updated.course.title, saylorFixture.courses[0]!.fullname);
    assert.equal(updated.course.durationMinutes, null); assert.equal(updated.course.externalId, '990001');
    assert.equal(updated.course.canonicalUrl, 'https://learn.saylor.org/course/view.php?id=990001');
    assert.equal(updated.publication, 'published'); assert.deepEqual(state, before);
});
test('Saylor TEST: vacío/parcial/fallo no cuentan ausencias ni afectan otras fuentes', async () => {
    const state = saylorTestSnapshot(); state.courses[0]!.missingCount = 2;
    for (const p of [provider({ courses: [] }), provider({ courses: [{}] }), new SaylorProvider({ mode: 'live' })]) {
        const report = await plan(p, state);
        assert.equal(report.plan.absenceEligible, false);
        assert.deepEqual(report.plan.next.courses, [...state.courses].sort((a, b) => a.internalId < b.internalId ? -1 : 1));
        assert.ok(!report.plan.actions.some(a => ['missing', 'withdrawn', 'deactivation_candidate'].includes(a.kind)));
    }
    const report = await plan();
    assert.deepEqual(report.plan.next.courses.find(c => c.internalId === 'TEST-other-source'), state.courses[1]);
});
test('Saylor TEST: presupuesto por ejecución/día y backoff compartidos, sin nuevas solicitudes', async () => {
    let calls = 0;
    const p = new SaylorProvider({ mode: 'fixture' }, async () => { calls++; return json(saylorFixture); }, now);
    const cfg = config(); cfg.queries.push({ ...query, categoryId: 99001 });
    const report = await plan(p, saylorTestSnapshot(), cfg);
    assert.equal(calls, 1); assert.equal(report.discovery.status, 'partial_failure');
    assert.equal(report.discovery.queries[1]!.error, 'QUERY_BUDGET_EXHAUSTED');
    assert.equal(report.plan.absenceEligible, false);
    const dayStore = memoryDiscoveryStore(); const state = await dayStore.load();
    state.day = saylorTestTime.slice(0, 10); state.requests = cfg.maxRequestsPerDay; await dayStore.save(state);
    await plan(p, saylorTestSnapshot(), config(), dayStore); assert.equal(calls, 1);
    const store = memoryDiscoveryStore();
    const limited = new SaylorProvider({ mode: 'fixture' }, async () => { calls++; return new Response(null, { status: 429 }); }, now);
    await plan(limited, saylorTestSnapshot(), config(), store); const after = calls;
    const blocked = await plan(limited, saylorTestSnapshot(), config(), store);
    assert.equal(blocked.discovery.status, 'provider_backoff'); assert.equal(calls, after);
});
test('Saylor TEST: repetición idempotente y caché del coordinador sin duplicados', async () => {
    let calls = 0; const store = memoryDiscoveryStore();
    const p = new SaylorProvider({ mode: 'fixture' }, async () => { calls++; return json(saylorFixture); }, now);
    const first = await plan(p, saylorTestSnapshot(), config(), store);
    const second = await plan(p, first.plan.next, config(), store);
    assert.equal(calls, 1); assert.equal(second.plan.skipped, true);
    assert.deepEqual(second.plan.next, first.plan.next);
});
test('Saylor TEST: CLI compatible, fixture explícito y rechazos live/apply/proveedor desconocido', async () => {
    assert.deepEqual(await runCourseSync([]), runSyncDemo([]));
    const report = await runCourseSync(['--provider', 'saylor', '--dry-run', '--fixture']);
    assert.equal(report.databaseAccess, false); assert.equal(report.publicationApproved, false);
    for (const args of [['--provider', 'unknown'], ['--provider', 'saylor', '--live'], ['--provider', 'saylor', '--apply'],
        ['--provider', 'saylor', '--provider', 'saylor']]) await assert.rejects(runCourseSync(args));
});
test('Saylor TEST: demostración sin credenciales y con red/escrituras/procesos hijos prohibidos por Node', () => {
    const script = `import { registerHooks } from 'node:module';
        registerHooks({ resolve(s, c, next) { try { return next(s,c); } catch(e) {
            if(s.startsWith('.') && s.endsWith('.js')) return next(s.slice(0,-3)+'.ts',c); throw e; } }});
        const { runCourseSync } = await import('./scripts/sync-courses.ts');
        console.log(JSON.stringify(await runCourseSync(['--provider','saylor','--dry-run','--fixture'])));`;
    const result = spawnSync(process.execPath, ['--permission', '--allow-fs-read=*', '--experimental-transform-types',
        '--input-type=module', '--eval', script], { encoding: 'utf8', env: { PATH: process.env.PATH, SystemRoot: process.env.SystemRoot } });
    assert.equal(result.status, 0, result.stderr);
    const report = JSON.parse(result.stdout);
    assert.equal(report.batch.duplicateIds, 1); assert.equal(report.plan.next.courses.length, 8);
    assert.equal(report.databaseAccess, false); assert.equal(report.publicationApproved, false);
    assert.equal(report.liveEnabled, false); assert.equal(report.plan.absenceEligible, false);
});
