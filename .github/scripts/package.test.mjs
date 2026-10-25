import assert from 'node:assert/strict';
import { test } from 'node:test';
import { validateEntries } from './verify-package.mjs';

const valid = ['dist/server.js', 'dist/app.js', 'package.json', 'package-lock.json',
    'node_modules/express/package.json', 'node_modules/dotenv/package.json', 'node_modules/pg/package.json'];

test('ZIP must contain the compiled server and required production dependencies', () => {
    assert.doesNotThrow(() => validateEntries(valid));
    for (const entry of valid) {
        assert.throws(() => validateEntries(valid.filter(item => item !== entry)), /ZIP missing/);
    }
});

test('ZIP rejects credentials, SQL, administrative tools and unexpected roots', () => {
    for (const entry of ['.env', 'dist/.env.production', 'node_modules/lib/.env', 'dist/private.key', 'dist/key.pem',
        '.git/config', '.npmrc', 'db/migrations/001.sql', 'dist/migrations/run.js', 'dist/seeds/demo.js',
        'dist/db/cli.js', 'dist/db/migrate.js', 'dist/db/seed.js', 'dist/credentials.json', 'dist/profile.publishsettings',
        'src/server.ts', 'test/app.test.ts', 'dist/../../outside', '/dist/absolute', 'dist\\server.js']) {
        assert.throws(() => validateEntries([...valid, entry]), undefined, entry);
    }
});
