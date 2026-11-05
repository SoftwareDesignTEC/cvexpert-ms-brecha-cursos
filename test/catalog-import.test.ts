import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { CatalogImportError, parseCatalogDocument } from '../scripts/catalog-import/document.js';
import { assertCatalogMaintenance } from '../scripts/catalog-import/importer.js';
import { parseArguments, readCatalogFile, safeImportError } from '../scripts/import-catalog.js';

const fixture = JSON.parse(await readFile(new URL('./fixtures/catalog-import.test.json', import.meta.url), 'utf8'));
const fresh = () => structuredClone(fixture);
test('catálogo v1 preserva null y exige esquema estricto y valores válidos', () => {
    assert.deepEqual(parseCatalogDocument(fresh()), fixture);
    const mutations: ((d: any) => void)[] = [
        d => { delete d.batchId; }, d => { d.extra = true; }, d => { d.formatVersion = '1'; },
        d => { d.reviewedAt = '2026-02-30T00:00:00.000Z'; }, d => { d.skills.push(d.skills[0]); },
        d => { d.courses.push(d.courses[0]); }, d => { d.courses[0].skills.push(d.courses[0].skills[0]); },
        d => { delete d.courses[0].logoUrl; }, d => { d.courses[0].extra = true; },
        ...['', ' bad', 'bad ', 'x\u0000', 'x\n', 'x\u202e', "x'; DROP TABLE skills; --"].map(title => (d: any) => { d.courses[0].title = title; }),
        ...['ftp://example.org', 'https://user:pass@example.org', 'https://@example.org', 'https://example.org/#secret', 'https://example.org/%E2%80%AE',
            'https://example.org/%0a', 'https://example.org/%xx', 'https:\\example.org', 'https://example.org/a b']
            .map(url => (d: any) => { d.courses[0].url = url; }),
        ...[-1, 1.1, '2', false, 2147483648].map(duration => (d: any) => { d.courses[0].durationHours = duration; }),
        d => { d.courses[0].isPaid = 'false'; }, d => { d.courses[0].logoUrl = ''; },
        d => { d.skills = []; d.courses = []; },
    ];
    for (const mutate of mutations) { const doc = fresh(); mutate(doc); assert.throws(() => parseCatalogDocument(doc), CatalogImportError); }
});
test('lectura acotada: UTF-8/JSON, campos y claves repetidas equivalentes', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'catalog-validation-'));
    const file = join(dir, 'input.json');
    try {
        await writeFile(file, JSON.stringify(fixture));
        assert.deepEqual(await readCatalogFile(file), fixture);
        for (const content of ['', '{', '{}', Buffer.from([0xff]), Buffer.alloc(1024 * 1024 + 1, 32),
            JSON.stringify(fixture).replace('"formatVersion":1', '"formatVersion":1,"formatVersion":1'),
            JSON.stringify(fixture).replace('"title":', '"t\\u0069tle":"duplicate","title":')]) {
            await writeFile(file, content);
            await assert.rejects(readCatalogFile(file), CatalogImportError);
        }
    } finally { await rm(dir, { recursive: true }); }
});
test('opciones cerradas y errores sin secretos', () => {
    assert.deepEqual(parseArguments(['--file', 'test.json']), { file: 'test.json', apply: false });
    assert.equal(parseArguments(['--apply', '--file', 'test.json']).apply, true);
    for (const args of [[], ['--file'], ['--password', 'secret'], ['--file', 'x', '--apply', '--apply'], ['--file', 'x', '--force']]) {
        assert.throws(() => parseArguments(args), CatalogImportError);
    }
    assert.ok(!safeImportError(new Error('secret')).includes('secret'));
});
test('guard rechaza producción, remoto/Azure y rol HTTP antes de conectar', () => {
    const env = { NODE_ENV: 'test', PGHOST: '127.0.0.1', PGUSER: 'maintenance', PGDATABASE: 'test', PGPASSWORD: 'test', DB_SSL_MODE: 'disable' };
    assertCatalogMaintenance(env);
    for (const patch of [{ NODE_ENV: 'production' }, { NODE_ENV: '' }, { PGHOST: 'azure.postgres.database.azure.com' },
        { PGHOST: '192.168.1.1' }, { PGHOST: '/tmp' }, { PGUSER: 'cvexpert_brecha_app' }, { WEBSITE_INSTANCE_ID: 'test-azure' }]) {
        assert.throws(() => assertCatalogMaintenance({ ...env, ...patch }), CatalogImportError);
    }
});
