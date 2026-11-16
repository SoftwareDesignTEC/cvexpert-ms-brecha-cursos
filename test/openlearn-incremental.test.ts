import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtemp, readFile, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { once } from 'node:events';
import { fixtureTransport } from '../scripts/openlearn-incremental/fixture.js';
import { preparePage, identityQuery, metadataQuery, queryVersion } from '../scripts/openlearn-incremental/provider.js';
import { initialize, status, fetchPage, applyPage, hash } from '../scripts/openlearn-incremental/session.js';
import { incrementalCli, editorialUrls } from '../scripts/openlearn-incremental-local.js';
import type { CourseSyncStaging } from '../scripts/course-sync/persistence.js';
import type { SyncCandidate } from '../scripts/course-sync/model.js';

const hooks = `import {registerHooks} from 'node:module'; registerHooks({resolve(s,c,next){try{return next(s,c);}catch(e){if(s.startsWith('.')&&s.endsWith('.js'))return next(s.slice(0,-3)+'.ts',c);throw e;}}});`;
const target = '127.0.0.1:5432:cvexpert_test_01234567890123456789012345678901:cvexpert_sync_ingest';
const result = { replay: false,skipped: false,actions: [],absenceEligible: false,massWithdrawalBlocked: false };
const fake = { execute: async () => result } as unknown as CourseSyncStaging;
async function temporary(work: (root: string) => Promise<void>) {
    const root = await mkdtemp(join(tmpdir(),'cvexpert-incremental-'));
    try { await work(root); } finally { assert.ok(resolve(root).startsWith(resolve(tmpdir()))); await rm(root,{ recursive: true,force: true }); }
}
function deps(request = fixtureTransport()) {
    let clock = Date.parse('2026-11-16T00:00:00.000Z');
    return { request,editorialUrls: new Set<string>(),now: () => clock,sleep: async (ms: number) => { clock += ms; },timeoutMs: 20 };
}

test('incremental guards: incompatible identities, response limits, target switch and stale staging run',async () => {
    const fixture = fixtureTransport();
    for (const mutation of ['duplicate','unordered','foreign','count','truncated','limit'] as const) {
        const request: typeof fetch = async url => {
            const response = await fixture(url), body = await response.json();
            const identity = body.head.vars.length === 1;
            if (identity && mutation === 'duplicate') body.results.bindings[1] = body.results.bindings[0];
            if (identity && mutation === 'unordered') body.results.bindings.reverse();
            if (!identity && mutation === 'foreign') body.results.bindings[0].resource.value = 'http://data.open.ac.uk/openlearn/test-foreign/content-section-0';
            if (!identity && mutation === 'count') body.results.bindings[0].rowCount.value = '3';
            if (!identity && mutation === 'limit') body.results.bindings = Array(201).fill(body.results.bindings[0]);
            return new Response(JSON.stringify(body),{ headers: { 'content-type': 'application/sparql-results+json',
                ...(mutation === 'truncated' ? { 'x-sparql-maxrows': '10' } : {}) } });
        };
        await assert.rejects(preparePage({ cursor: null,size: 2,runId: 'TEST-unsafe-page',observedAt: new Date().toISOString() },request,async () => {},new Set()),
            /NON_MONOTONIC|UNEXPECTED_RESOURCE|INCOMPLETE|INVALID_METADATA/);
    }
    await temporary(async root => {
        await initialize(root,'fixture',null); await fetchPage(root,'fixture',null,deps());
        await assert.rejects(applyPage(root,'fixture',{ execute: async () => ({ ...result,skipped: true }) } as any,target),/STAGING_RUN_SKIPPED/);
        assert.equal((await status(root,'fixture')).confirmedCursor,null);
        await assert.rejects(applyPage(root,'fixture',fake,target.replace(':5432:',':5433:')),/SESSION_TARGET_CHANGED/);
    });
    await temporary(async root => {
        await initialize(root,'fixture',null);
        const path = join(root,'local-catalog-input/discovery/fixture-openlearn-incremental.json');
        const state = JSON.parse(await readFile(path,'utf8'));
        const id = '01234567-0123-0123-0123-012345678901'; state.requests = 1;
        state.pending = { runId: id,observedAt: new Date().toISOString(),file: `openlearn-${id}.json`,hash: null };
        await writeFile(path,JSON.stringify(state));
        const s = await status(root,'fixture'); assert.equal(s.recovery,'INTERRUPTED_FETCH_REVIEW_REQUIRED'); assert.equal(s.requests,1);
        await assert.rejects(fetchPage(root,'fixture',null,deps()),/INTERRUPTED_FETCH/);
    });
});
const options = { pageSize: 10,maxPages: 2,maxRequests: 4,minIntervalMs: 2000 };

test('incremental A/B/D: durable artifacts, keyset identity pages and all RDF categories', async () => temporary(async root => {
    const d = deps(); await initialize(root,'fixture',null,null,options);
    const first = await fetchPage(root,'fixture',null,d);
    assert.equal(first.resources.length,10); assert.equal(first.records.length,11); assert.equal(first.requests.length,2);
    assert.equal(first.run.scope,'query'); assert.equal(first.run.missingPages,true); assert.equal(first.run.status,'partial');
    const c = first.run.candidates as SyncCandidate[];
    assert.deepEqual(c[0]!.associatedSkills,[]); assert.equal(c[0]!.isPaid,null); assert.equal(c[0]!.durationMinutes,null);
    assert.equal(c.filter(x => x.externalId === c[0]!.externalId).length,2);
    assert.equal((await status(root,'fixture')).confirmedCursor,null);
    assert.deepEqual(await fetchPage(root,'fixture',null,{ ...d,request: async () => { throw Error('MUST_NOT_FETCH'); } }),first);
    await applyPage(root,'fixture',fake,target);
    const second = await fetchPage(root,'fixture',null,d);
    assert.equal(second.resources.length,2); assert.ok(second.resources.every(id => !first.resources.includes(id)));
    assert.equal(second.cursorBefore,first.cursorNext); assert.ok(second.cursorNext! > first.cursorNext!);
    await applyPage(root,'fixture',fake,target);
    const s = await status(root,'fixture'); assert.equal(s.requests,4); assert.equal(s.seen.length,12); assert.equal(s.pagesApplied,2);
    await assert.rejects(fetchPage(root,'fixture',null,d),/BUDGET_EXHAUSTED/);
    await assert.rejects(initialize(root,'fixture',null),/SESSION_ALREADY_EXISTS/);
}));

test('incremental E: network failures, 429 Retry-After, 5xx, JSON and truncation never advance cursor', async () => {
    const fixture = fixtureTransport();
    for (const [code,transport] of [
        ['RATE_LIMITED',async () => new Response('SECRET',{ status: 429,headers: { 'retry-after': '3600' } })],
        ['TIMEOUT',async () => new Promise<Response>(() => {})],
        ['PROVIDER_UNAVAILABLE',async () => new Response('SECRET',{ status: 503 })],
        ['INVALID_SPARQL_RESPONSE',async () => new Response('{',{ headers: { 'content-type': 'application/sparql-results+json' } })],
        ['INCOMPLETE_METADATA',async (url: Parameters<typeof fetch>[0]) => {
            const response = await fixture(url), body = await response.json();
            if (body.head.vars.includes('rowCount')) body.results.bindings.pop();
            return new Response(JSON.stringify(body),{ headers: { 'content-type': 'application/sparql-results+json' } });
        }],
    ] as const) await temporary(async root => {
        await initialize(root,'fixture',null); const d = deps(transport), a = await fetchPage(root,'fixture',null,d);
        assert.equal(a.run.status,'failed'); assert.deepEqual(a.run.errors,[code]); assert.equal(a.advanceAllowed,false);
        assert.equal(a.cursorNext,null); assert.equal(a.run.candidates.length,0); assert.ok(a.requests.length);
        assert.equal(JSON.stringify(a).includes('SECRET'),false);
        const s = await status(root,'fixture'); assert.ok(s.requests > 0); assert.equal(s.confirmedCursor,null);
        if (code === 'RATE_LIMITED') assert.ok(s.blockedUntil >= d.now() + 3600000);
        await applyPage(root,'fixture',fake,target); assert.equal((await status(root,'fixture')).confirmedCursor,null);
        await assert.rejects(fetchPage(root,'fixture',null,d),/BACKOFF|FAILED_PAGE|BUDGET/);
    });
});

test('incremental F/G: rollback and uncertain commit replay the identical run without HTTP', async () => temporary(async root => {
    await initialize(root,'fixture',null); const d = deps(), a = await fetchPage(root,'fixture',null,d);
    await assert.rejects(applyPage(root,'fixture',{ execute: async () => { throw Error('ROLLBACK'); } } as any,target),/ROLLBACK/);
    assert.equal((await status(root,'fixture')).confirmedCursor,null);
    let committed: string | undefined;
    const staging = { execute: async (run: unknown) => {
        if (!committed) { committed = hash(run); throw Error('COMMIT_UNCERTAIN_RETRY_SAME_RUN'); }
        assert.equal(hash(run),committed); return { ...result,replay: true };
    } } as CourseSyncStaging;
    await assert.rejects(applyPage(root,'fixture',staging,target),/COMMIT_UNCERTAIN/);
    assert.equal((await applyPage(root,'fixture',staging,target)).result.replay,true);
    assert.equal((await status(root,'fixture')).confirmedCursor,a.cursorNext);
    assert.equal((await status(root,'fixture')).requests,2);
}));

test('incremental recovery after artifact rename but before state confirmation; tampering and incompatible query fail closed', async () => temporary(async root => {
    await initialize(root,'fixture',null); const a = await fetchPage(root,'fixture',null,deps());
    const path = join(root,'local-catalog-input/discovery/fixture-openlearn-incremental.json');
    const s = JSON.parse(await readFile(path,'utf8')); s.pending.hash = null; await writeFile(path,JSON.stringify(s));
    assert.equal(hash(await fetchPage(root,'fixture',null,deps(async () => { throw Error('NO_HTTP'); }))),hash(a));
    s.pending.hash = '0'.repeat(64); await writeFile(path,JSON.stringify(s));
    await assert.rejects(applyPage(root,'fixture',fake,target),/INVALID_PENDING/);
    s.queryVersion = 'incompatible'; await writeFile(path,JSON.stringify(s));
    await assert.rejects(status(root,'fixture'),/INCOMPATIBLE_QUERY_VERSION/);
}));

test('incremental I: editorial URL/alias collision flagged, no RDF identity adoption', async () => {
    const urls = await editorialUrls(); assert.ok(urls.has('https://www.open.edu/openlearn/digital-computing/simple-coding/content-section-0'));
    const f = fixtureTransport(); const request: typeof fetch = async url => {
        const body = await (await f(url)).json();
        if (body.head.vars.includes('rowCount')) for (const row of body.results.bindings) row.url.value = [...urls][0];
        return new Response(JSON.stringify(body),{ headers: { 'content-type': 'application/sparql-results+json' } });
    };
    const a = await preparePage({ cursor: null,size: 1,runId: 'TEST-editorial-overlap',observedAt: new Date().toISOString() },request,async () => {},urls);
    assert.ok(a.editorialConflicts.every(c => c.code === 'EDITORIAL_IDENTITY_REVIEW_REQUIRED'));
    assert.ok(a.editorialConflicts.length); assert.ok((a.run.candidates as SyncCandidate[]).every(c => c.validation === 'conflict'));
});

test('incremental controlled queries, explicit authorizations, default CLI has no socket or workers', async () => {
    assert.match(identityQuery(null,10),/SELECT DISTINCT/); assert.match(metadataQuery(['http://data.open.ac.uk/openlearn/test/content-section-0']),/COUNT\(\*\)/);
    assert.throws(() => identityQuery('"> } UNION { ?s ?p ?o',10),/INVALID_RESOURCE/);
    await assert.rejects(incrementalCli(['init','--root','unused','--mode','live','--cursor','start'],{ NODE_ENV: 'test' }),/LOCAL_PILOT_ONLY/);
    await assert.rejects(incrementalCli(['apply-local','--root','unused'],{}),/LOCAL_DISPOSABLE/);
    await assert.rejects(initialize('unused','live',null),/SOURCE_AUTHORIZATION/);
    const script = hooks + `const {incrementalCli}=await import('./scripts/openlearn-incremental-local.ts'); console.log(JSON.stringify(await incrementalCli([],{})));`;
    const p = spawnSync(process.execPath,['--permission','--allow-fs-read=*','--experimental-transform-types','--input-type=module','-e',script],
        { encoding: 'utf8',env: { PATH: process.env.PATH,SystemRoot: process.env.SystemRoot } });
    assert.equal(p.status,0,p.stderr); const report = JSON.parse(p.stdout);
    assert.equal(report.databaseAccess,false); assert.equal(report.externalRequests,0); assert.equal(report.artifact.resources.length,10);
});

test('incremental H: two real processes share lock and durable reservation before transport', { timeout: 20000 }, async () => temporary(async root => {
    await initialize(root,'fixture',null);
    const script = hooks + `const {fetchPage}=await import('./scripts/openlearn-incremental/session.ts');
        const {fixtureTransport}=await import('./scripts/openlearn-incremental/fixture.ts'); const f=fixtureTransport();
        await fetchPage(process.argv[1],'fixture',null,{editorialUrls:new Set(),request:async(...args)=>{
            process.send('reserved'); await new Promise(r=>process.once('message',r)); return f(...args);}});`;
    const child = spawn(process.execPath,['--experimental-transform-types','--input-type=module','-e',script,root],{ stdio: ['ignore','pipe','pipe','ipc'] });
    let stderr = ''; child.stderr!.on('data',b => { stderr += b; });
    try {
        await once(child,'message');
        const disk = JSON.parse(await readFile(join(root,'local-catalog-input/discovery/fixture-openlearn-incremental.json'),'utf8'));
        assert.equal(disk.requests,1); assert.ok(disk.pending); assert.equal(disk.confirmedCursor,null);
        const second = spawnSync(process.execPath,['--experimental-transform-types','--input-type=module','-e',hooks +
            `const {fetchPage}=await import('./scripts/openlearn-incremental/session.ts'); try{await fetchPage(process.argv[1],'fixture',null,{});process.exitCode=2;}catch(e){console.log(e.message);}`,root],{ encoding: 'utf8' });
        assert.equal(second.status,0,second.stderr); assert.match(second.stdout,/DISCOVERY_LOCKED/);
        child.send('continue'); await once(child,'message'); child.send('continue');
        const [code] = await once(child,'exit'); assert.equal(code,0,stderr);
        assert.equal((await status(root,'fixture')).requests,2);
    } finally { child.kill(); }
}));
