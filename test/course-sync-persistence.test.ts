import assert from 'node:assert/strict';
import { test } from 'node:test';
import { assertLocalTarget } from '../scripts/course-sync/postgres.js';
import { localSyncConfig, runLocalSync } from '../scripts/sync-courses-local.js';

test('staging local rechaza Azure, base compartida, rol HTTP y configuración implícita', async () => {
    const target = { host: '127.0.0.1', database: `cvexpert_test_${'a'.repeat(32)}`, user: 'cvexpert_sync_ingest' };
    assert.doesNotThrow(() => assertLocalTarget(target));
    for (const patch of [{ host: 'test.postgres.database.azure.com' },{ host: 'localhost' },
        { database: 'cvexpert_ci' },{ user: 'cvexpert_brecha_app' },{ user: 'postgres' }]) {
        assert.throws(() => assertLocalTarget({ ...target,...patch }), /LOCAL_DISPOSABLE/);
    }
    assert.throws(() => localSyncConfig({ PGHOST: '127.0.0.1' }), /LOCAL_DISPOSABLE/);
    const env = { NODE_ENV: 'test', COURSE_SYNC_HOST: target.host, COURSE_SYNC_DATABASE: target.database,
        COURSE_SYNC_USER: target.user, COURSE_SYNC_PASSWORD: 'TEST-only', COURSE_SYNC_PORT: '5432',
        COURSE_SYNC_CONFIRM_DISPOSABLE: target.database };
    assert.equal(localSyncConfig(env).ssl,false);
    assert.throws(() => localSyncConfig({ ...env, COURSE_SYNC_CONFIRM_DISPOSABLE: '' }), /EXPLICIT_LOCAL/);
    await assert.rejects(runLocalSync(['--apply','missing.json'],env), /apply-local/);
});
