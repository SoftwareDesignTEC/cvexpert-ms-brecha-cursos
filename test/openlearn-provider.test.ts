import assert from 'node:assert/strict';
import { test } from 'node:test';
import { spawnSync } from 'node:child_process';
import { DiscoveryError } from '../scripts/course-discovery/model.js';
import { OpenLearnProvider, openLearnEndpoint, openLearnGraph, openLearnSelect, openLearnCourseUrl } from '../scripts/course-discovery/openlearn-provider.js';
import { planDiscoveryQuery } from '../scripts/course-sync/worker.js';
import { runOpenLearnProbe, parseOpenLearnArguments } from '../scripts/probe-openlearn.js';
import { openLearnFixture, openLearnTestSnapshot, openLearnTestTime, testBinding, testSparql, literal, uri } from './fixtures/openlearn.test.js';

const now = () => Date.parse(openLearnTestTime);
const query = { skill: '[TEST] Untrusted input: } SERVICE <https://example.org> {' };
const json = (value: unknown) => new Response(JSON.stringify(value), { headers: { 'content-type': 'application/sparql-results+json' } });
const provider = (value: unknown = openLearnFixture()) => new OpenLearnProvider({}, async () => json(value), now);
const search = (p = provider()) => p.search(query, async () => {});
const code = (expected: string) => (error: unknown) => error instanceof DiscoveryError && error.code === expected;

test('OpenLearn TEST: SELECT fijo, grafo openlearn2, límite 10 y sin interpolación del usuario', async () => {
    let reserved = false;
    const p = new OpenLearnProvider({ mode: 'live' }, async (input, options) => {
        assert.equal(reserved, true);
        const url = new URL(String(input));
        assert.equal(url.origin + url.pathname, openLearnEndpoint);
        assert.deepEqual([...url.searchParams.keys()], ['query']);
        assert.equal(url.searchParams.get('query'), openLearnSelect);
        assert.equal(options?.method, 'GET'); assert.equal(options?.redirect, 'error'); assert.equal(options?.credentials, 'omit');
        assert.equal(new Headers(options?.headers).get('accept'), 'application/sparql-results+json');
        assert.equal(new Headers(options?.headers).has('authorization'), false);
        return json(openLearnFixture());
    }, now);
    await p.search(query, async () => { reserved = true; });
    assert.ok(openLearnSelect.includes(`<${openLearnGraph}>`)); assert.match(openLearnSelect, /LIMIT 10$/);
    assert.doesNotMatch(openLearnSelect, /SERVICE|OFFSET|context\/course>|context\/openlearn>/);
    await assert.rejects(search(p), code('QUERY_BUDGET_EXHAUSTED')); assert.equal(p.requests, 1);
});
test('OpenLearn TEST: identidad del dataset, URL preservada, disciplinas y metadatos desconocidos', async () => {
    const p = provider(), page = await search(p);
    assert.equal(page.candidates.length, 6); assert.equal(page.rejected, 2); assert.equal(page.truncated, true);
    assert.equal(p.lastObservation!.received, 8); assert.equal(p.lastObservation!.duplicateIds, 1);
    assert.deepEqual([...new Set(page.candidates.flatMap(c => c.evidence[0]!.subjects))].sort(),
        ['[TEST] business', '[TEST] education', '[TEST] health', '[TEST] languages', '[TEST] science']);
    for (const c of page.candidates) {
        assert.equal(c.source, 'openlearn'); assert.match(c.title, /^\[TEST\]/);
        assert.equal(c.isPaid, null); assert.equal(c.durationMinutes, null); assert.equal(c.language, null);
        assert.deepEqual(c.levels, []); assert.deepEqual(c.associatedSkills, []);
        assert.equal(c.validation, 'needs_review'); assert.equal(c.canonicalUrl, c.url);
        assert.equal(c.evidence[0]!.summary, null); assert.equal(c.queriedAt, openLearnTestTime);
    }
    assert.equal(page.candidates[0]!.externalId, '990001');
});
test('OpenLearn TEST: sin ID interno usa IRI real sin fabricar ID; idioma del título no es idioma docente', async () => {
    const row: Record<string, unknown> = { ...testBinding(), title: { ...literal('[TEST] Título'), 'xml:lang': 'en' } };
    delete row.internalId; delete row.subject;
    const page = await search(provider(testSparql([row])));
    assert.equal(page.candidates[0]!.externalId, testBinding().resource.value);
    assert.equal(page.candidates[0]!.language, null); assert.deepEqual(page.candidates[0]!.evidence[0]!.subjects, []);
    const clone = provider(); await search(clone);
    const observation = clone.lastObservation!; observation.records.length = 0;
    assert.equal(clone.lastObservation!.records.length, 6);
});
test('OpenLearn TEST: rechaza HTTP histórico, URLs ajenas, credenciales, queries y rutas ambiguas sin reescribir', () => {
    const valid = testBinding().url.value;
    assert.equal(openLearnCourseUrl(valid), valid);
    for (const url of [valid.replace('https:', 'http:'), valid.replace('www.open.edu', 'evil.test'),
        valid.replace('www.open.edu', 'user@www.open.edu'), valid.replace('www.open.edu', 'www.open.edu:443'),
        `${valid}?token=TEST`, `${valid}#fragment`, valid.replace('content-section-0', 'content-section-1'),
        valid.replace('/test-education/', '/test-education/../'), valid.replace('/test-education/', '/%74est-education/')]) assert.throws(() => openLearnCourseUrl(url));
});
test('OpenLearn TEST: un título no basta; artículos, nulos, términos RDF inválidos y campos inventados se rechazan', async () => {
    const row = testBinding();
    const invalid = [{ ...row, type: uri('https://schema.org/Article') }, { ...row, type: undefined }, { ...row, title: null },
        { ...row, title: uri('https://example.org/TEST') }, { ...row, url: literal(row.url.value) },
        { ...row, internalId: literal('') }, { ...row, internalId: literal('0') },
        { ...row, resource: uri('http://data.open.ac.uk/course/TEST') }, { ...row, subject: null },
        { ...row, duration: literal('60') }, { ...row, isPaid: literal('false') }];
    const page = await search(provider(testSparql(invalid.slice(0, 10))));
    assert.equal(page.rejected, 10); assert.equal(page.candidates.length, 0);
    assert.equal((await search(provider(testSparql([invalid[10]])))).rejected, 1);
});
test('OpenLearn TEST: esquema inesperado, head incompleto, JSON truncado y UTF-8 inválido', async () => {
    for (const body of [null, [], {}, { boolean: true }, { head: { vars: [] }, results: { bindings: [] } },
        { ...testSparql([]), nextLink: 'https://evil.test' }, { ...testSparql([]), warnings: ['TEST'] },
        { ...testSparql([]), results: { bindings: null } }]) {
        await assert.rejects(search(provider(body)), code('INVALID_SPARQL_RESPONSE'));
    }
    for (const bytes of ['{"head":', new Uint8Array([0xff])]) {
        await assert.rejects(search(new OpenLearnProvider({}, async () => new Response(bytes, {
            headers: { 'content-type': 'application/sparql-results+json' } }))), code('INVALID_SPARQL_RESPONSE'));
    }
});
test('OpenLearn TEST: respuesta parcial, contador incompatible y aviso de truncamiento bloquean el resultado', async () => {
    for (const body of [{ ...testSparql([]), meta: { 'result-size-total': 1 } },
        { ...testSparql([]), meta: { partial: true } }]) await assert.rejects(search(provider(body)), code('INCOMPLETE_RESPONSE'));
    for (const response of [new Response('{}', { status: 206 }), new Response('{}', { headers: { 'x-sparql-maxrows': '10' } })]) {
        await assert.rejects(search(new OpenLearnProvider({}, async () => response)), code('INCOMPLETE_RESPONSE'));
    }
    const empty = await search(provider(testSparql([])));
    assert.equal(empty.candidates.length, 0); assert.equal(empty.truncated, true);
});
test('OpenLearn TEST: límite de filas y bytes no convierte recortes en éxito', async () => {
    await assert.rejects(search(provider(testSparql(Array.from({ length: 11 }, () => testBinding())))), code('RECORD_LIMIT_EXCEEDED'));
    await assert.rejects(search(new OpenLearnProvider({ maxResponseBytes: 32 }, async () => json(openLearnFixture()))), code('RESPONSE_TOO_LARGE'));
    for (const options of [{ timeoutMs: 0 }, { timeoutMs: 15001 }, { maxResponseBytes: 262145 }, { maxResponseBytes: 1.5 }]) {
        assert.throws(() => new OpenLearnProvider(options), code('INVALID_CONFIG'));
    }
});
test('OpenLearn TEST: errores HTTP/cuota seguros sin reintentos, un solo intento por instancia', async () => {
    for (const [status, expected] of [[401, 'PROVIDER_UNAUTHORIZED'], [403, 'PROVIDER_UNAUTHORIZED'], [404, 'PROVIDER_HTTP_ERROR'],
        [429, 'RATE_LIMITED'], [500, 'PROVIDER_UNAVAILABLE'], [503, 'PROVIDER_UNAVAILABLE']] as const) {
        let calls = 0;
        const p = new OpenLearnProvider({}, async () => { calls++; return new Response('TEST_PRIVATE_MARKER', { status, headers: { 'retry-after': '120' } }); });
        await assert.rejects(search(p), error => {
            assert.ok(code(expected)(error)); assert.doesNotMatch(String(error), /TEST_PRIVATE_MARKER/);
            if (status === 429) assert.equal((error as DiscoveryError).retryAfterMs, 120000);
            return true;
        });
        await assert.rejects(search(p), code('QUERY_BUDGET_EXHAUSTED')); assert.equal(calls, 1);
    }
});
test('OpenLearn TEST: redirecciones/origen efectivo diferente y tipos de contenido rechazados', async () => {
    for (const response of [new Response(null, { status: 302 }), Object.defineProperty(json(testSparql([])), 'url', { value: 'https://evil.test' }),
        Object.defineProperty(json(testSparql([])), 'redirected', { value: true })]) {
        await assert.rejects(search(new OpenLearnProvider({}, async () => response)), code('UNSAFE_REDIRECT'));
    }
    for (const type of ['text/html', 'application/json', 'application/sparql-results+json-evil']) {
        await assert.rejects(search(new OpenLearnProvider({}, async () => new Response('{}', { headers: { 'content-type': type } }))), code('INVALID_CONTENT_TYPE'));
    }
});
test('OpenLearn TEST: timeout de transporte y lectura; errores de red saneados', async () => {
    for (const request of [async () => new Promise<Response>(() => {}),
        async () => new Response(new ReadableStream({ start() {} }), { headers: { 'content-type': 'application/sparql-results+json' } })]) {
        await assert.rejects(search(new OpenLearnProvider({ timeoutMs: 20 }, request)), code('TIMEOUT'));
    }
    await assert.rejects(search(new OpenLearnProvider({}, async () => { throw new Error('TEST_PRIVATE_MARKER'); })), code('PROVIDER_NETWORK_ERROR'));
});
test('OpenLearn TEST: reserva evita peticiones concurrentes y no hay fetch por defecto en fixture', async () => {
    await assert.rejects(search(new OpenLearnProvider()), code('FIXTURE_TRANSPORT_REQUIRED'));
    let calls = 0;
    const p = new OpenLearnProvider({}, async () => { calls++; return json(testSparql([])); });
    const results = await Promise.allSettled([search(p), search(p)]);
    assert.equal(calls, 1); assert.equal(results.filter(r => r.status === 'fulfilled').length, 1);
    let blockedCalls = 0;
    const blocked = new OpenLearnProvider({}, async () => { blockedCalls++; return json(testSparql([])); });
    await assert.rejects(blocked.search(query, async () => { throw new DiscoveryError('QUERY_BUDGET_EXHAUSTED'); }), code('QUERY_BUDGET_EXHAUSTED'));
    assert.equal(blockedCalls, 0);
});
test('OpenLearn TEST: motor existente propone inserciones, duplicado y actualización; protege otra fuente', async () => {
    const report = await runOpenLearnProbe([]);
    assert.equal(report.dataSource, 'TEST_SYNTHETIC_ONLY'); assert.equal(report.observation!.rejected.length, 2);
    assert.equal(report.plan.actions.filter(a => a.kind === 'insert').length, 4);
    assert.equal(report.plan.actions.filter(a => a.kind === 'duplicate').length, 1);
    assert.equal(report.plan.actions.filter(a => a.kind === 'update').length, 1);
    const before = openLearnTestSnapshot();
    assert.deepEqual(report.plan.next.courses.find(c => c.internalId === 'TEST-other-provider'), before.courses[1]);
    assert.equal(report.plan.next.courses.find(c => c.internalId === 'TEST-openlearn-existing')!.publication, 'published');
    assert.equal(report.plan.absenceEligible, false); assert.equal(report.publicationApproved, false);
    assert.equal(report.databaseAccess, false); assert.equal(report.periodicSyncApproved, false);
});
test('OpenLearn TEST: identidad estable con URL/título distintos y conflictos sin elegir ganador', async () => {
    const before = openLearnTestSnapshot(), row = testBinding();
    const changed = { ...row, title: literal('[TEST] Título actualizado'), url: uri(row.url.value.replace('test-990001', 'test-new')) };
    const result = await planDiscoveryQuery(provider(testSparql([changed])), query, { load: async () => before },
        { runId: 'TEST-change', observedAt: openLearnTestTime });
    assert.equal(result.actions[0]!.kind, 'update'); assert.equal(result.actions[0]!.internalId, 'TEST-openlearn-existing');
    assert.equal(result.next.courses.find(c => c.internalId === 'TEST-openlearn-existing')!.course.canonicalUrl, changed.url.value);
    const conflict = await planDiscoveryQuery(provider(testSparql([row, changed])), query, { load: async () => before },
        { runId: 'TEST-conflict', observedAt: openLearnTestTime });
    assert.equal(conflict.actions[0]!.kind, 'ambiguous');
});
test('OpenLearn TEST: vacío, incompleto y error no incrementan ausencias ni desactivan', async () => {
    const before = openLearnTestSnapshot(); before.courses[0]!.missingCount = 2;
    for (const p of [provider(testSparql([])), provider({}), provider(testSparql([{ ...testBinding(), type: uri('https://schema.org/Article') }]))]) {
        const result = await planDiscoveryQuery(p, query, { load: async () => structuredClone(before) },
            { runId: 'TEST-protected', observedAt: openLearnTestTime });
        assert.equal(result.absenceEligible, false);
        assert.ok(!result.actions.some(a => ['missing', 'deactivation_candidate', 'withdrawn'].includes(a.kind)));
        assert.deepEqual(result.next.courses, [...before.courses].sort((a,b) => a.internalId < b.internalId ? -1 : 1));
    }
});
test('OpenLearn TEST: argumentos cerrados, fixture predeterminado y live bloqueado en tests/CI/producción', async () => {
    assert.equal(parseOpenLearnArguments([]), 'fixture');
    for (const args of [['--query', 'SELECT'], ['--limit', '100'], ['--live', '--fixture'], ['--live', '--live'], ['--apply'], ['--endpoint', 'TEST']]) {
        assert.throws(() => parseOpenLearnArguments(args), code('INVALID_ARGUMENTS'));
    }
    for (const env of [{ CI: 'true' }, { GITHUB_ACTIONS: 'true' }, { NODE_ENV: 'test' }, { NODE_ENV: 'production' }, { WEBSITE_SITE_NAME: 'TEST' }]) {
        let calls = 0;
        await assert.rejects(runOpenLearnProbe(['--live'], { env, request: async () => { calls++; return json(testSparql([])); } }), code('LOCAL_PROBE_ONLY'));
        assert.equal(calls, 0);
    }
    const mocked = await runOpenLearnProbe(['--live'], { env: {}, now, request: async () => json(testSparql([testBinding()])) });
    assert.equal(mocked.transport, 'live'); assert.equal(mocked.plan.actions[0]!.kind, 'insert');
    assert.ok(mocked.plan.next.courses.every(c => !c.internalId.startsWith('TEST-')));
});
test('OpenLearn TEST: reporte de fallo conserva código seguro y no finge respuesta verificada', async () => {
    const report = await runOpenLearnProbe([], { request: async () => new Response('TEST_PRIVATE_MARKER', { status: 429 }) });
    assert.equal(report.status, 'failed'); assert.equal(report.observation, null); assert.equal(report.error!.code, 'RATE_LIMITED');
    assert.equal(report.plan.absenceEligible, false); assert.doesNotMatch(JSON.stringify(report), /TEST_PRIVATE_MARKER/);
});
test('OpenLearn TEST: idempotencia con el mismo snapshot proyectado y observación', async () => {
    const first = await runOpenLearnProbe([]);
    const repeated = await planDiscoveryQuery(provider(), query, { load: async () => first.plan.next },
        { runId: `openlearn-probe:fixture:${openLearnTestTime}`, observedAt: openLearnTestTime });
    assert.equal(repeated.skipped, true); assert.deepEqual(repeated.next, first.plan.next);
});
test('OpenLearn TEST: CLI predeterminada sin red, escrituras ni credenciales bajo permisos de Node', () => {
    const script = `import { registerHooks } from 'node:module';
        registerHooks({resolve(s,c,next){try{return next(s,c);}catch(e){if(s.startsWith('.')&&s.endsWith('.js'))return next(s.slice(0,-3)+'.ts',c);throw e;}}});
        const {runOpenLearnProbe}=await import('./scripts/probe-openlearn.ts');console.log(JSON.stringify(await runOpenLearnProbe([])));`;
    const result = spawnSync(process.execPath, ['--permission','--allow-fs-read=*','--experimental-transform-types','--input-type=module','--eval',script],
        { encoding:'utf8', env:{PATH:process.env.PATH,SystemRoot:process.env.SystemRoot} });
    assert.equal(result.status, 0, result.stderr);
    const report=JSON.parse(result.stdout);
    assert.equal(report.transport,'fixture');assert.equal(report.databaseAccess,false);assert.equal(report.publicationApproved,false);
    assert.equal(report.observation.received,8);assert.equal(report.plan.absenceEligible,false);
});
