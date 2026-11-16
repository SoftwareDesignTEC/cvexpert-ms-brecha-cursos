import assert from 'node:assert/strict';
import { test } from 'node:test';
import { spawnSync } from 'node:child_process';
import { discoverFreeCodeCamp,discoverOpenLearn,officialCourseUrl,IngestError } from '../src/ingestion/providers.js';
import { ingestionConfig,startPeriodicIngestion,type IngestionReport } from '../src/ingestion/runtime.js';
import { automaticTransport,automaticSnapshot } from './fixtures/automatic-courses.test.js';

const env = { NODE_ENV: 'test',COURSES_INGEST_HOST: '127.0.0.1',COURSES_INGEST_PORT: '5432',COURSES_INGEST_DATABASE: 'TEST-local',
    COURSES_INGEST_USER: 'cvexpert_course_ingest',COURSES_INGEST_PASSWORD: 'TEST-only',COURSES_INGEST_SSL_MODE: 'disable' };
test('automatic providers: real metadata snapshot, two sources, individual free evidence and exact skills',async t => {
    t.mock.method(globalThis,'fetch',async () => { throw Error('EXTERNAL_NETWORK_FORBIDDEN'); });
    const openlearn = await discoverOpenLearn(automaticTransport()), fcc = await discoverFreeCodeCamp(automaticTransport());
    assert.equal(openlearn.found,3); assert.equal(openlearn.courses.length,2);
    assert.ok(openlearn.rejected.some(r => r.reason === 'OFFICIAL_HTTPS_ROUTE_NOT_VERIFIED'));
    assert.equal(openlearn.courses.find(c => c.title === 'Network security')!.url,'https://www.open.edu/openlearn/digital-computing/network-security/content-section-0');
    assert.equal(fcc.found,4); assert.equal(fcc.courses.length,4); assert.equal(fcc.sources.length,3);
    assert.deepEqual(fcc.courses.find(c => c.title === 'Python Certification')!.skills,['Python']);
    assert.deepEqual(fcc.courses.find(c => c.title === 'JavaScript Certification')!.skills,['JavaScript']);
    assert.deepEqual(fcc.courses.find(c => c.title === 'Relational Databases Certification')!.skills,['SQL','Git']);
    for (const c of [...openlearn.courses,...fcc.courses]) {
        assert.equal(c.isPaid,false); assert.equal(c.durationHours,null); assert.ok(c.url.startsWith('https://'));
        assert.ok(c.evidence.every(e => /^[a-f0-9]{64}$/.test(e.sha256)));
    }
});
test('automatic associations: Java is not JavaScript, titles and generic categories do not grant skills',async () => {
    const snapshot = structuredClone(automaticSnapshot);
    snapshot.intro['javascript-v9'].intro = ['This course teaches Java programming.'];
    snapshot.intro['javascript-v9'].blocks = {};
    snapshot.intro['python-v9'].intro = ['General digital skills.'];
    snapshot.intro['python-v9'].blocks = {};
    const r = await discoverFreeCodeCamp(automaticTransport(snapshot));
    assert.ok(!r.courses.some(c => c.skills.includes('JavaScript') || c.skills.includes('Python')));
    assert.equal(r.rejected.filter(c => c.reason === 'NO_SUPPORTED_SKILL_EVIDENCE').length,2);
});
test('automatic provider failures: no retry, no body/secrets leaked, bad JSON/content, truncation and missing free proof',async () => {
    for (const request of [
        async () => new Response('SECRET',{ status: 429,headers: { 'retry-after': '172800' } }),
        async () => new Response('SECRET',{ status: 503 }),
        async () => new Response('<html>SECRET</html>',{ headers: { 'content-type': 'text/html' } }),
        async () => new Response('{}',{ headers: { 'content-type': 'application/json','x-sparql-maxrows': '10' } }),
        async () => new Response('{',{ headers: { 'content-type': 'application/json' } }),
        async () => { throw new DOMException('SECRET','TimeoutError'); },
    ]) {
        let calls = 0;
        await assert.rejects(discoverOpenLearn(async (...args) => { calls++; return request(...args as []); }));
        assert.equal(calls,1);
    }
    await assert.rejects(discoverOpenLearn(async () => new Response('',{ status: 429,headers: { 'retry-after': '172800' } })),
        (e: IngestError) => e.code === 'PROVIDER_RATE_LIMITED' && e.retryAfterMs === 172800000 && !e.message.includes('SECRET'));
    const s = structuredClone(automaticSnapshot);
    s.openlearn.results.bindings.forEach((r: any) => { r.description.value = 'This paid course teaches information security.'; });
    assert.equal((await discoverOpenLearn(automaticTransport(s))).courses.length,0);
    s.readme = 'No individual free-access statement.';
    await assert.rejects(discoverFreeCodeCamp(automaticTransport(s)),/FREE_ACCESS_NOT_VERIFIED/);
});
test('automatic URL policy: no foreign hosts, tracking, credentials or unchecked legacy aliases; conflicting metadata rejected',async () => {
    for (const url of ['https://example.org/course','https://www.open.edu@evil.test/openlearn/a/content-section-0',
        'https://www.open.edu/openlearn/a/content-section-0?token=SECRET']) assert.throws(() => officialCourseUrl(url,'openlearn'));
    const s = structuredClone(automaticSnapshot), row = s.openlearn.results.bindings.find((r: any) => r.title.value === 'Information security');
    delete s.openlearn.meta;
    s.openlearn.results.bindings = [row,{ ...structuredClone(row),description: { type: 'literal',value: 'This free course teaches information security with Python.' } }];
    const r = await discoverOpenLearn(automaticTransport(s)); assert.equal(r.courses.length,0); assert.equal(r.rejected[0].reason,'CONTRADICTORY_METADATA');
    s.openlearn.results.bindings = [{ ...row,title: { type: 'literal',value: '[TEST] Wrong identity for known alias' } }];
    assert.equal((await discoverOpenLearn(automaticTransport(s))).rejected[0].reason,'CANONICAL_ALIAS_IDENTITY_MISMATCH');
});
test('automatic config: dedicated login/variables, no fallback to admin or API PG credentials; remote TLS mandatory',async () => {
    assert.throws(() => ingestionConfig({ PGHOST: 'production',PGUSER: 'postgres',PGPASSWORD: 'SECRET' }),/EXPLICIT_INGEST/);
    assert.throws(() => ingestionConfig({ ...env,COURSES_INGEST_USER: 'cvexpert_brecha_app' }),/LIMITED_INGEST/);
    assert.throws(() => ingestionConfig({ ...env,COURSES_INGEST_HOST: 'shared.postgres.database.azure.com' }),/REMOTE_TLS/);
    assert.equal(ingestionConfig(env).user,'cvexpert_course_ingest');
    const p = spawnSync(process.execPath,['dist/ingestion/cli.js','--dry-run'],{ encoding: 'utf8',env: { PATH: process.env.PATH,SystemRoot: process.env.SystemRoot } });
    assert.equal(p.status,1); assert.match(p.stderr,/ARGUMENTS_NOT_SUPPORTED/); assert.equal(p.stdout,'');
});
test('automatic periodic task: default off, explicit bounds, no overlap, shutdown and Retry-After honored',async t => {
    let tick = () => {}, calls = 0, finish: (r: IngestionReport) => void = () => {};
    t.mock.method(globalThis,'setInterval',((fn: () => void,ms: number) => {
        assert.equal(ms,6 * 3600000); tick = fn; return { unref() {} };
    }) as any);
    t.mock.method(globalThis,'clearInterval',() => {});
    await startPeriodicIngestion({},() => { throw Error('MUST_NOT_LOG'); },async () => { throw Error('MUST_NOT_RUN'); })();
    assert.throws(() => startPeriodicIngestion({ ...env,COURSES_INGEST_ENABLED: 'true',COURSES_INGEST_INTERVAL_HOURS: '0' }),/INVALID_INGEST_INTERVAL/);
    const stop = startPeriodicIngestion({ ...env,COURSES_INGEST_ENABLED: 'true',COURSES_INGEST_INTERVAL_HOURS: '6' },() => {},() => {
        calls++; return new Promise(resolve => { finish = resolve; });
    });
    tick(); tick(); assert.equal(calls,1);
    finish({ synchronizedAt: new Date().toISOString(),status: 'failed',sources: [{ provider: 'openlearn',error: 'PROVIDER_RATE_LIMITED',retryAfterMs: 172800000 }] });
    await new Promise(resolve => setImmediate(resolve)); tick(); assert.equal(calls,1);
    await stop(); tick(); assert.equal(calls,1);
});
