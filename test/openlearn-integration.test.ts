import assert from 'node:assert/strict';
import { test } from 'node:test';
import { spawnSync } from 'node:child_process';
import { mkdtemp, readFile, unlink, rmdir } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { OpenLearnProvider, openLearnSelect } from '../scripts/course-discovery/openlearn-provider.js';
import { discoverOpenLearn, parsePreparedOpenLearn } from '../scripts/course-sync/openlearn-integration.js';
import { prepareOpenLearnFixture, runOpenLearnIntegration } from '../scripts/integrate-openlearn-local.js';
import { openLearnTestTime, testBinding, testSparql } from './fixtures/openlearn.test.js';

test('OpenLearn integración: fixture predeterminado sin red, SQL ni asociaciones', async t => {
    t.mock.method(globalThis,'fetch',async () => { throw new Error('EXTERNAL_NETWORK_FORBIDDEN'); });
    const report = await runOpenLearnIntegration([],{ PGHOST: 'forbidden.postgres.database.azure.com' });
    assert.equal(report.databaseAccess,false);
    const p = await prepareOpenLearnFixture();
    assert.equal(p.run.scope,'query'); assert.equal(p.run.status,'partial'); assert.equal(p.run.missingPages,true);
    assert.equal(p.rejected.length,2);
    assert.ok(p.run.candidates.every((c: any) => c.associatedSkills.length === 0 && c.durationMinutes === null));
    assert.deepEqual(parsePreparedOpenLearn(p),p);
    const child = spawnSync(process.execPath,['--permission','--allow-fs-read=*','--import','tsx','scripts/integrate-openlearn-local.ts'],{ encoding: 'utf8' });
    assert.equal(child.status,0,child.stderr);
    assert.equal(JSON.parse(child.stdout).databaseAccess,false);
});
test('OpenLearn integración: flags cerrados, destino explícito y artefacto inmutable', async () => {
    for (const args of [['--live'],['--live','--apply-local','missing'],['--apply'],['--history-local','extra']]) {
        await assert.rejects(runOpenLearnIntegration(args,{}),/INVALID_ARGUMENTS/);
    }
    await assert.rejects(runOpenLearnIntegration(['--apply-local','missing'],{}),/LOCAL_DISPOSABLE/);
    const dir = await mkdtemp(join(tmpdir(),'cvexpert-openlearn-run-')), file = join(dir,'TEST-run.json');
    try {
        await runOpenLearnIntegration(['--prepare',file],{});
        const original = await readFile(file,'utf8');
        await assert.rejects(runOpenLearnIntegration(['--prepare',file],{}),/EEXIST/);
        assert.equal(await readFile(file,'utf8'),original);
    } finally { await unlink(file); await rmdir(dir); }
    const prepared = await prepareOpenLearnFixture();
    assert.throws(() => parsePreparedOpenLearn({ ...prepared,run: { ...prepared.run,scope: 'full_catalog' } }),/INVALID_OPENLEARN/);
    const skilled = structuredClone(prepared); (skilled.run.candidates[0] as any).associatedSkills = ['SQL'];
    assert.throws(() => parsePreparedOpenLearn(skilled),/SKILLS_REQUIRE_EDITORIAL/);
});
test('OpenLearn integración: errores seguros, consulta fija y presupuesto por instancia', async () => {
    const input = { runId: 'TEST-errors',observedAt: openLearnTestTime };
    for (const [code,request] of [
        ['RATE_LIMITED',async () => new Response('SECRET',{ status: 429 })],
        ['INVALID_SPARQL_RESPONSE',async () => new Response('{',{ headers: { 'content-type': 'application/sparql-results+json' } })],
        ['TIMEOUT',async () => new Promise<Response>(() => {})],
    ] as const) {
        const p = await discoverOpenLearn(new OpenLearnProvider({ timeoutMs: 10 },request,() => Date.parse(openLearnTestTime)),input);
        assert.equal(p.run.status,'failed'); assert.deepEqual(p.run.errors,[code]);
        assert.equal(p.run.valid,false); assert.equal(p.run.candidates.length,0);
        assert.equal(JSON.stringify(p).includes('SECRET'),false);
    }
    let calls = 0;
    const provider = new OpenLearnProvider({},async url => {
        calls++; assert.equal(new URL(String(url)).searchParams.get('query'),openLearnSelect);
        return new Response(JSON.stringify(testSparql([testBinding()])),{ headers: { 'content-type': 'application/sparql-results+json' } });
    },() => Date.parse(openLearnTestTime));
    const results = await Promise.all([discoverOpenLearn(provider,input),discoverOpenLearn(provider,{ ...input,runId: 'TEST-parallel' })]);
    assert.equal(calls,1);
    assert.equal(results.filter(p => p.run.errors.includes('QUERY_BUDGET_EXHAUSTED')).length,1);
    assert.deepEqual((await discoverOpenLearn(provider,input)).run.errors,['QUERY_BUDGET_EXHAUSTED']);
    assert.equal(calls,1);
});
