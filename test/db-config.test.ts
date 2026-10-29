import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { Pool } from 'pg';
import { getDatabaseConfig } from '../src/db/config.js';
import { seedDemo } from '../src/db/seed.js';

// Cadena ficticia solo para comprobar configuración; no conecta a un servidor.
const environment: NodeJS.ProcessEnv = {
    NODE_ENV: 'test', PGHOST: '127.0.0.1', PGPORT: '5433',
    PGDATABASE: 'test_catalog', PGUSER: 'test_user', PGPASSWORD: 'test-placeholder',
    DB_SSL_MODE: 'disable',
};

test('configura el pool local sin conectar a PostgreSQL', () => {
    const config = getDatabaseConfig(environment);
    assert.equal(config.port, 5433);
    assert.equal(config.ssl, false);
    assert.equal(config.max, 5);
    assert.equal(config.connectionTimeoutMillis, 5000);
});

test('TLS verifica certificados por defecto y no permite deshabilitarlo fuera de development/test', () => {
    assert.deepEqual(getDatabaseConfig({ ...environment, NODE_ENV: 'production', DB_SSL_MODE: undefined }).ssl,
        { rejectUnauthorized: true });
    for (const NODE_ENV of ['production', 'staging', undefined]) {
        assert.throws(() => getDatabaseConfig({ ...environment, NODE_ENV }), /TLS/);
    }
    assert.throws(() => getDatabaseConfig({ ...environment, DB_SSL_MODE: 'require' }), /DB_SSL_MODE/);
    assert.throws(() => getDatabaseConfig({ ...environment, PGSSLROOTCERT: 'unused.pem' }), /PGSSLROOTCERT/);
});

test('rechaza configuración incompleta sin revelar el valor de las credenciales', () => {
    for (const name of ['PGHOST', 'PGDATABASE', 'PGUSER', 'PGPASSWORD']) {
        assert.throws(() => getDatabaseConfig({ ...environment, [name]: '' }), new RegExp(name));
    }
    for (const PGPORT of ['0', '65536', '-1', '1.5', 'abc', '5433junk', '']) {
        assert.throws(() => getDatabaseConfig({ ...environment, PGPORT }), /PGPORT/);
    }
});

test('el seed rechaza producción antes de pedir conexiones', async () => {
    const unusedPool = {} as Pool;
    for (const mode of ['production', 'staging', '']) {
        await assert.rejects(seedDemo(unusedPool, mode), /solo se permite/);
    }
});
