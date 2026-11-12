import assert from 'node:assert/strict';
import { readFile, mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { parseCatalogDocument } from '../scripts/catalog-import/document.js';
import { parseDiscoveryArguments, runDiscovery } from '../scripts/discover-courses.js';
import { LearnPlatformProvider, learnApi, learnVersion } from '../scripts/course-discovery/learn-provider.js';
import { consolidateCandidates, DiscoveryError, parseDiscoveryConfig, safeCourseUrl, skillKey, type CourseDiscoveryProvider } from '../scripts/course-discovery/model.js';
import { discoverCourses } from '../scripts/course-discovery/service.js';
import { emptyState, readJson, withDiscoveryStore, type DiscoveryState, type DiscoveryStore } from '../scripts/course-discovery/store.js';
import { evaluateJobSkillsGap } from '../src/services/job-skills-gap.service.js';

const fixture = JSON.parse(await readFile(new URL('./fixtures/course-discovery/modules.json', import.meta.url), 'utf8'));
const record = fixture.value[0];
const config = (extra = {}) => parseDiscoveryConfig({ queries: [{ skill: 'Python', products: ['test-product-python'] }], ...extra });
const now = () => Date.parse('2026-11-11T12:00:00.000Z');
const json = (value: unknown) => new Response(JSON.stringify(value), { headers: { 'content-type': 'application/json' } });
const provider = (request: typeof fetch = async () => json(fixture), extra = {}) =>
    new LearnPlatformProvider(config(extra), async () => 'test-token', request, now);
const search = (source = provider()) => source.search(config().queries[0]!, async () => {});
function memoryStore() {
    let state = emptyState();
    return { async load() { return structuredClone(state); }, async save(next: DiscoveryState) { state = structuredClone(next); } } satisfies DiscoveryStore;
}
async function temporary(work: (root: string) => Promise<void>) {
    const root = await mkdtemp(join(tmpdir(), 'cvexpert-discovery-test-'));
    try { await work(root); } finally { await rm(root, { recursive: true, force: true }); }
}

test('Learn v1: consulta parametrizada y candidato estructurado, sin aprobación ni precio inventado', async () => {
    const result = await search(provider(async (input, options) => {
        const url = new URL(String(input));
        assert.equal(url.origin + url.pathname, learnApi);
        assert.equal(url.searchParams.get('api-version'), learnVersion);
        assert.equal(url.searchParams.get('products'), 'test-product-python');
        assert.equal(url.searchParams.has('q'), false);
        assert.equal(new Headers(options?.headers).get('authorization'), 'Bearer test-token');
        assert.equal(options?.redirect, 'error');
        return json(fixture);
    }));
    const candidate = result.candidates[0]!;
    assert.equal(candidate.externalId, record.id);
    assert.deepEqual(candidate.associatedSkills, ['Python']);
    assert.equal(candidate.durationMinutes, 45);
    assert.equal(candidate.language, 'en-us');
    assert.deepEqual(candidate.levels, ['beginner']);
    assert.equal(candidate.isPaid, null);
    assert.equal(candidate.validation, 'needs_review');
    assert.match(candidate.evidence[0]!.responseSha256, /^[a-f0-9]{64}$/u);
    assert.equal(candidate.queriedAt, new Date(now()).toISOString());
    assert.equal(JSON.stringify(result).includes('test-token'), false);
});

test('datos opcionales ausentes se conservan desconocidos; incompletos y filtro no respaldado se descartan', async () => {
    const incomplete = { ...record, locale: undefined, levels: undefined, summary: undefined, durationInMinutes: undefined };
    const result = await search(provider(async () => json({ value: [incomplete,
        { ...record, id: undefined }, { ...record, title: '' }, { ...record, products: [] },
        { ...record, durationInMinutes: '45' }, { ...record, durationInMinutes: -1 }, { ...record, type: 'exam' }] })));
    assert.equal(result.rejected, 6);
    assert.equal(result.candidates.length, 1);
    assert.equal(result.candidates[0]!.durationMinutes, null);
    assert.equal(result.candidates[0]!.language, null);
    assert.deepEqual(result.candidates[0]!.levels, []);
    assert.equal(result.candidates[0]!.isPaid, null);
});

test('un título con Python no acredita pertinencia ni sustituye los metadatos estructurados', async () => {
    const result = await search(provider(async () => json({ value: [{ ...record, title: 'Python Python Python', products: [{ id: 'java' }] }] })));
    assert.equal(result.candidates.length, 0);
    assert.equal(result.rejected, 1);
});

test('URLs peligrosas, tracking y rutas indirectas se rechazan sin descargarlas ni arreglarlas', () => {
    for (const url of ['javascript:alert(1)', 'http://learn.microsoft.com/training/modules/test/',
        'https://learn.microsoft.com@evil.test/training/modules/test/',
        'https://@learn.microsoft.com/training/modules/test/', 'https://127.0.0.1/training/modules/test/',
        'https://learn.microsoft.com.evil.test/training/modules/test/', 'https://learn.microsoft.com:8443/training/modules/test/',
        'https://learn.microsoft.com/training/modules/test/?token=secret', 'https://learn.microsoft.com/training/modules/test/#fragment',
        'https://learn.microsoft.com/training/modules/test/?', 'https://learn.microsoft.com/training/modules/test/#',
        'https:///learn.microsoft.com/training/modules/test/',
        'https://learn.microsoft.com/training/modules/a/../test/', 'https://learn.microsoft.com/training/modules/%74est/',
        'https://learn.microsoft.com\\@evil.test/training/modules/test/']) assert.throws(() => safeCourseUrl(url));
    assert.equal(safeCourseUrl('https://LEARN.microsoft.com:443/training/modules/test/'), 'https://learn.microsoft.com/training/modules/test/');
    assert.notEqual(safeCourseUrl('https://learn.microsoft.com/training/modules/test/'), safeCourseUrl('https://learn.microsoft.com/training/modules/test'));
});

test('respuestas malformadas, HTML y cuerpos excesivos son errores explícitos', async () => {
    for (const response of [() => json({}), () => json({ value: {} }), () => json({ value: [], nextLink: 1 }),
        () => new Response('{', { headers: { 'content-type': 'application/json' } }),
        () => new Response('<html>error</html>'), () => new Response(' '.repeat(1024 * 1024 + 1), { headers: { 'content-type': 'application/json' } })]) {
        await assert.rejects(search(provider(async () => response())), DiscoveryError);
    }
});

test('429, 5xx, 401 y errores HTTP no exponen cuerpos ni credenciales y no reintentan automáticamente', async () => {
    for (const [status, code] of [[429, 'RATE_LIMITED'], [500, 'PROVIDER_UNAVAILABLE'], [503, 'PROVIDER_UNAVAILABLE'],
        [401, 'PROVIDER_UNAUTHORIZED'], [403, 'PROVIDER_UNAUTHORIZED'], [400, 'PROVIDER_HTTP_ERROR']] as const) {
        let calls = 0;
        await assert.rejects(search(provider(async () => {
            calls++;
            return new Response('secret-provider-error', { status, headers: { 'retry-after': '120' } });
        })), (error: unknown) => error instanceof DiscoveryError && error.code === code && !error.message.includes('secret'));
        assert.equal(calls, 1);
    }
});

test('timeout acota autenticación, transporte y lectura aun si el doble ignora AbortSignal', async () => {
    await assert.rejects(search(provider(async () => new Promise(() => {}), { timeoutMs: 10 })), { code: 'TIMEOUT' });
    const tokenStuck = new LearnPlatformProvider(config({ timeoutMs: 10 }), async () => new Promise(() => {}));
    await assert.rejects(search(tokenStuck), { code: 'TIMEOUT' });
    await assert.rejects(search(provider(async () => new Response(new ReadableStream({ start() {} }),
        { headers: { 'content-type': 'application/json' } }), { timeoutMs: 10 })), { code: 'TIMEOUT' });
});

test('paginación acotada; no envía token a otro origen, ruta ni versión y detecta ciclos', async () => {
    for (const nextLink of ['https://evil.test/api/v1/modules', 'https://learn.microsoft.com/api/catalog/',
        `${learnApi}?api-version=unknown`]) {
        let calls = 0;
        await assert.rejects(search(provider(async () => { calls++; return json({ value: [], nextLink }); })), { code: 'UNSAFE_PAGINATION' });
        assert.equal(calls, 1);
    }
    let calls = 0;
    const result = await search(provider(async () => { calls++; return json({ value: [record], nextLink: `${learnApi}?cursor=${calls}` }); }));
    assert.equal(calls, 2);
    assert.equal(result.truncated, true);
    await assert.rejects(search(provider(async () => json({ value: [], nextLink: `${learnApi}?cursor=repeat` }), { maxPages: 3 })), { code: 'UNSAFE_PAGINATION' });
});

test('deduplicación por fuente/id y URL segura conserva asociaciones y evidencia; conflictos quedan retenidos', async () => {
    const candidate = (await search()).candidates[0]!;
    const duplicate = structuredClone(candidate);
    duplicate.associatedSkills = ['SQL'];
    const result = consolidateCandidates([candidate, duplicate, structuredClone(candidate)]);
    assert.equal(result.length, 1);
    assert.deepEqual(result[0]!.associatedSkills, ['Python', 'SQL']);
    assert.equal(result[0]!.evidence.length, 1);
    const conflict = structuredClone(candidate);
    conflict.title = 'Otro título'; conflict.evidence[0]!.title = conflict.title;
    const retained = consolidateCandidates([candidate, conflict]);
    assert.equal(retained[0]!.validation, 'conflict');
    assert.equal(retained[0]!.evidence.length, 2);
    assert.ok(retained[0]!.reviewReasons.includes('SOURCE_METADATA_CONFLICT'));
    const alternate = structuredClone(candidate);
    alternate.externalId = 'another-source-id';
    assert.equal(consolidateCandidates([candidate, alternate]).length, 1);
});

test('habilidades canónicas preservadas, normalización sin sinonimias y colisiones explícitas', () => {
    assert.equal(skillKey(' PYTHON '), skillKey('Python'));
    assert.notEqual(skillKey('Python'), skillKey('Python 3'));
    assert.notEqual(skillKey('Java'), skillKey('JavaScript'));
    assert.notEqual(skillKey('C'), skillKey('C++'));
    assert.throws(() => config({ queries: [{ skill: 'Python', products: ['python'] }, { skill: 'python', products: ['python'] }] }), { code: 'AMBIGUOUS_SKILL' });
    assert.throws(() => config({ queries: [{ skill: 'Python' }] }), { code: 'MISSING_SKILL_FILTER' });
    assert.throws(() => config({ maxPages: 0 }));
    assert.throws(() => config({ queries: [{ skill: 'Python', products: ['python&secret=x'] }] }));
    assert.equal(config().queries[0]!.skill, 'Python');
});

test('caché evita nuevas llamadas; un fallo posterior no elimina la última propuesta ni aparenta datos frescos', async () => {
    const store = memoryStore();
    let calls = 0, fail = false, clock = now();
    const source = provider(async () => { calls++; if (fail) throw new Error('secret'); return json(fixture); });
    const run = () => discoverCourses(source, config(), store, { mode: 'fixture' }, () => clock, async () => {});
    assert.equal((await run()).queries[0]!.status, 'fetched');
    assert.equal((await run()).queries[0]!.status, 'cached');
    assert.equal(calls, 1);
    const cached = structuredClone((await store.load()).cache);
    fail = true; clock += 7 * 3600000;
    const failure = await run();
    assert.equal(failure.status, 'partial_failure');
    assert.equal(failure.candidates.length, 0);
    assert.deepEqual((await store.load()).cache, cached);
});

test('cuotas persistidas por intento, configuración no reinicia presupuesto y Retry-After se respeta entre ticks', async () => {
    const store = memoryStore();
    const double: CourseDiscoveryProvider = { name: 'test', async search(_query, permit) { await permit(); await permit(); return { candidates: [], rejected: 0, truncated: false }; } };
    const limited = await discoverCourses(double, config({ maxRequestsPerRun: 1, maxRequestsPerDay: 1 }), store, { mode: 'fixture' }, now, async () => {});
    assert.equal(limited.status, 'partial_failure');
    assert.equal(limited.requests, 1);
    const again = await discoverCourses(double, config({ maxRequestsPerDay: 1, locale: 'es-es' }), store, { mode: 'fixture' }, now, async () => {});
    assert.equal(again.requests, 0);
    assert.equal(again.queries[0]!.error, 'QUERY_BUDGET_EXHAUSTED');
    const throttled = memoryStore();
    const source = provider(async () => new Response(null, { status: 429, headers: { 'retry-after': '90000' } }));
    await discoverCourses(source, config(), throttled, { mode: 'fixture' }, now, async () => {});
    assert.equal((await throttled.load()).blockedUntil, now() + 90000000);
    const report = await discoverCourses(source, config(), throttled, { mode: 'fixture' }, now, async () => {});
    assert.equal(report.status, 'provider_backoff');
    assert.equal(report.requests, 0);
});

test('programación desactivada por defecto; tick habilitado respeta intervalo sin timer de arranque', async () => {
    const store = memoryStore();
    let calls = 0;
    const source = provider(async () => { calls++; return json(fixture); });
    assert.equal((await discoverCourses(source, config(), store, { mode: 'fixture', scheduled: true }, now)).status, 'disabled');
    assert.equal(calls, 0);
    assert.equal((await discoverCourses(source, config({ enabled: true }), store, { mode: 'fixture', scheduled: true }, now)).status, 'completed');
    assert.equal((await discoverCourses(source, config({ enabled: true }), store, { mode: 'fixture', scheduled: true }, now)).status, 'not_due');
    assert.equal(calls, 1);
});

test('catálogo anterior intacto: snapshot se valida y URL existente se marca para revisión, sin conversión automática a v1', async () => {
    const candidate = (await search()).candidates[0]!;
    const catalog = parseCatalogDocument({ formatVersion: 1, batchId: 'test-catalog', reviewedAt: new Date(now()).toISOString(), skills: ['Python'],
        courses: [{ title: 'Curso anterior', platform: 'Catálogo anterior', url: candidate.url,
            isPaid: false, durationHours: null, logoUrl: null, skills: ['Python'], sourceReference: candidate.url }] });
    const before = structuredClone(catalog);
    const result = consolidateCandidates([candidate], catalog);
    assert.deepEqual(catalog, before);
    assert.equal(result[0]!.validation, 'conflict');
    assert.ok(result[0]!.reviewReasons.includes('EXISTING_CATALOG_URL_REVIEW'));
    assert.equal(result[0]!.isPaid, null);
    assert.throws(() => parseCatalogDocument(result));
    assert.equal(evaluateJobSkillsGap({ cv: { id: 'cv-test', skills: [] }, jobs: [{ id: 'job-test', skills: ['Python'] }] }).results[0]!.documentedCoveragePercent, 0);
});

test('CLI offline determinista, sin identidad externa/PG; archivos solo de propuestas y locks aislados', async () => temporary(async root => {
    const report = await runDiscovery(['--dry-run', '--fixture', '--skill', ' python '], {
        NODE_ENV: 'test', PGHOST: 'must-not-connect.postgres.database.azure.com', PGUSER: 'unused', PGPASSWORD: 'unused-test-value',
    }, root);
    assert.equal(report.dataSource, 'deterministic_test_fixture');
    assert.equal(report.databaseAccess, false);
    assert.equal(report.publicationApproved, false);
    assert.equal(report.candidates[0]!.isPaid, null);
    assert.equal(report.candidates[0]!.associatedSkills[0], 'Python');
    const stored = await readJson(join(root, 'local-catalog-input/discovery/latest-fixture.json'));
    assert.deepEqual(stored, report);
    await assert.rejects(withDiscoveryStore(root, 'fixture', async () => withDiscoveryStore(root, 'fixture', async () => {})), { code: 'DISCOVERY_LOCKED' });
    await withDiscoveryStore(root, 'live', async store => assert.deepEqual(await store.load(), emptyState()));
    const again = await runDiscovery(['--fixture'], {}, root);
    assert.deepEqual(again.candidates, report.candidates);
    assert.equal(again.requests, 0);
}));

test('cada solicitud reserva cuota en su día UTC, incluso si la ejecución cruza medianoche', async () => {
    const store = memoryStore();
    let time = Date.parse('2026-11-11T23:59:59.000Z');
    const source: CourseDiscoveryProvider = { name: 'test', async search(_query, permit) {
        await permit(); time += 3000; await permit();
        return { candidates: [], rejected: 0, truncated: false };
    } };
    const result = await discoverCourses(source, config({ maxRequestsPerDay: 1 }), store, { mode: 'fixture' }, () => time, async () => {});
    assert.equal(result.requests, 2);
    assert.equal(result.status, 'completed');
    assert.equal((await store.load()).day, '2026-11-12');
    assert.equal((await store.load()).requests, 1);
});

test('fallo de persistencia impide la llamada externa; estado inválido no reinicia silenciosamente la cuota', async () => {
    let calls = 0;
    const store: DiscoveryStore = { async load() { return emptyState(); }, async save() { throw new Error('disk unavailable'); } };
    await assert.rejects(discoverCourses(provider(async () => { calls++; return json(fixture); }), config(), store, { mode: 'fixture' }, now));
    assert.equal(calls, 0);
    await temporary(async root => {
        await withDiscoveryStore(root, 'fixture', async state => state.save({ ...emptyState(), requests: -1 }));
        await assert.rejects(withDiscoveryStore(root, 'fixture', async state => state.load()), { code: 'INVALID_STATE' });
    });
});

test('CLI no autoriza red por credenciales solas; falta de token es explícita; --apply no existe', async () => temporary(async root => {
    assert.throws(() => parseDiscoveryArguments(['--apply']), { code: 'INVALID_ARGUMENTS' });
    assert.throws(() => parseDiscoveryArguments(['--live', '--fixture']), { code: 'INVALID_ARGUMENTS' });
    const path = join(root, 'config.json');
    await writeFile(path, JSON.stringify(config({ enabled: true })));
    await assert.rejects(runDiscovery(['--live', '--config', path], { LEARN_ACCESS_TOKEN: 'test-token' }, root), { code: 'LIVE_DISCOVERY_NOT_AUTHORIZED' });
    await assert.rejects(runDiscovery(['--live', '--config', path], { COURSE_DISCOVERY_STORAGE_APPROVED: 'true' }, root), { code: 'CREDENTIALS_REQUIRED' });
    await assert.rejects(runDiscovery(['--fixture'], { NODE_ENV: 'production' }, root), { code: 'LOCAL_MAINTENANCE_ONLY' });
    await writeFile(path, '{"enabled":false,"enabled":true}');
    await assert.rejects(readJson(path), { code: 'DUPLICATE_JSON_KEY' });
    await assert.rejects(search(new LearnPlatformProvider(config(), async () => '', async () => { assert.fail('No debe llamar al proveedor'); })), { code: 'CREDENTIALS_REQUIRED' });
}));
