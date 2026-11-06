import assert from 'node:assert/strict';
import { readFile, mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import type { Pool, PoolClient } from 'pg';
import { administrativeConfig, parseTarget } from '../scripts/admin-import/config.js';
import { planAdministrativeImport, prepareInput, verifySession } from '../scripts/admin-import/planner.js';
import { parseAdminArguments, runAdministrativeImport, safeAdministrativeError } from '../scripts/admin-import.js';

const target = { server: 'test.postgres.database.azure.com', database: 'test_db', identity: 'test_maintenance', port: 5432 };
const catalog = JSON.parse(await readFile(new URL('./fixtures/catalog-import.test.json', import.meta.url), 'utf8'));
const market = JSON.parse(await readFile(new URL('./fixtures/market-import.test.json', import.meta.url), 'utf8'));
const scale = JSON.parse(await readFile(new URL('./fixtures/market-import.test-scale.json', import.meta.url), 'utf8'));
const env = { ADMIN_IMPORT_SERVER: target.server, ADMIN_IMPORT_DATABASE: target.database,
    ADMIN_IMPORT_IDENTITY: target.identity, ADMIN_IMPORT_PORT: '5432', ADMIN_IMPORT_PASSWORD: 'TEST-secret-not-logged' };

test('destino revisado y configuración TLS estricta; rechazos antes del socket', () => {
    assert.deepEqual(parseTarget(target), target);
    for (const patch of [{ server: 'localhost' }, { server: 'test.postgres.database.azure.com.evil.org' },
        { server: 'https://test.postgres.database.azure.com' }, { port: 0 }, { port: 65536 }, { port: '5432' }, { database: '' },
        { identity: 'cvexpert_brecha_app' }, { identity: 'CVEXPERT_BRECHA_APP@test' }, { unexpected: true }]) {
        assert.throws(() => parseTarget({ ...target, ...patch }));
    }
    const config = administrativeConfig(parseTarget(target), env);
    assert.equal(config.host, target.server);
    assert.deepEqual(config.ssl, { rejectUnauthorized: true, servername: target.server });
    assert.match(config.options!, /default_transaction_read_only=on/);
    for (const patch of [{ ADMIN_IMPORT_SERVER: 'other.postgres.database.azure.com' },
        { ADMIN_IMPORT_DATABASE: 'other' }, { ADMIN_IMPORT_IDENTITY: 'other' }, { ADMIN_IMPORT_PASSWORD: '' },
        { NODE_TLS_REJECT_UNAUTHORIZED: '0' }, { WEBSITE_SITE_NAME: 'test' }, { GITHUB_ACTIONS: 'true' }]) {
        assert.throws(() => administrativeConfig(parseTarget(target), { ...env, ...patch }));
    }
    // Ambient backend credentials cannot select the maintenance target.
    assert.throws(() => administrativeConfig(parseTarget(target), { PGHOST: target.server, PGPASSWORD: 'test' }));
});

test('no apply, force, updates ni opción repetida; validadores originales y demo rechazados', () => {
    const args = ['--target', 't', '--catalog', 'c', '--market', 'm', '--scale', 's'];
    assert.equal(parseAdminArguments(args).connectAzure, false);
    for (const suffix of [['--apply'], ['--force'], ['--allow-updates'], ['--catalog', 'again'], ['--connect-azure', '--connect-azure']]) {
        assert.throws(() => parseAdminArguments([...args, ...suffix]));
    }
    assert.throws(() => prepareInput({ ...catalog, skills: ['', ''] }, market, scale));
    assert.throws(() => prepareInput(catalog, { ...market, records: market.records.map((r: object) => ({ ...r, dataKind: 'demo' })) }, scale), /demo/);
    assert.throws(() => prepareInput(catalog, market, { ...scale, levels: [1, 1] }));
    assert.equal(safeAdministrativeError(new Error(env.ADMIN_IMPORT_PASSWORD)), safeAdministrativeError(null));
    assert.ok(!safeAdministrativeError(new Error(env.ADMIN_IMPORT_PASSWORD)).includes(env.ADMIN_IMPORT_PASSWORD));
});

test('offline CLI no conecta incluso con credenciales remotas inválidas; lector JSON compartido', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'admin-import-test-'));
    try {
        const entries = { target, catalog, market, scale };
        const args: string[] = [];
        for (const [name, value] of Object.entries(entries)) {
            const path = join(dir, `${name}.json`);
            await writeFile(path, JSON.stringify(value));
            args.push(`--${name}`, path);
        }
        const report = await runAdministrativeImport(args, {});
        assert.equal(report.mode, 'offline-validation');
        assert.equal(report.applyAvailable, false);
        assert.match(report.inputSha256, /^[a-f0-9]{64}$/);
        await writeFile(join(dir, 'target.json'), '{"server":1,"server":2}');
        await assert.rejects(runAdministrativeImport(args, {}), /duplicadas/);
    } finally { await rm(dir, { recursive: true }); }
});

test('fallo TLS revierte, libera y nunca consulta catálogo ni escribe', async () => {
    for (const stream of [{}, { encrypted: true, authorized: false },
        { encrypted: true, authorized: true, servername: 'wrong' },
        { encrypted: true, authorized: true, servername: target.server, getProtocol: () => 'TLSv1.1' }]) {
        const queries: string[] = [];
        let released = false;
        const pool = { connect: async () => ({ connection: { stream }, query: async (sql: string) => {
            queries.push(sql); return { rows: [] };
        }, release: () => { released = true; } }) } as unknown as Pool;
        await assert.rejects(planAdministrativeImport(pool, parseTarget(target), prepareInput(catalog, market, scale)), /TLS/);
        assert.deepEqual(queries, ['BEGIN', 'SET TRANSACTION ISOLATION LEVEL REPEATABLE READ, READ ONLY', 'ROLLBACK']);
        assert.ok(released);
    }
});

test('identidades SQL, destino, TLS de servidor y privilegios efectivos cierran el preflight', async () => {
    const base = { database: target.database, identity: target.identity, session_identity: target.identity,
        read_only: 'on', isolation: 'repeatable read', server_address: '127.0.0.1', server_port: target.port,
        tls: true, restricted: true, schema_allowed: true, can_read: true, no_dml: true,
        no_snapshots: true, ordinary_tables: true };
    for (const patch of [{ database: 'wrong' }, { identity: 'cvexpert_brecha_app' },
        { session_identity: 'cvexpert_brecha_app' }, { identity: 'other' }, { session_identity: 'other' },
        { read_only: 'off' }, { isolation: 'read committed' }, { server_address: null },
        { server_port: 5433 }, { tls: false }, { restricted: false }, { schema_allowed: false },
        { can_read: false }, { no_dml: false }, { no_snapshots: false }, { ordinary_tables: false }]) {
        let calls = 0;
        const client = { connection: { stream: { encrypted: true, authorized: true,
            servername: target.server, getProtocol: () => 'TLSv1.3' } },
            query: async () => { calls++; return { rows: [{ ...base, ...patch }] }; } } as unknown as PoolClient;
        await assert.rejects(verifySession(client, parseTarget(target)), /permisos mínimos/);
        assert.equal(calls, 1); // No history or data queries after a rejected session.
    }
});
