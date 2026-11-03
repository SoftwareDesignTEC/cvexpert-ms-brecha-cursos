import assert from 'node:assert/strict';
import { mkdtemp, readFile, rmdir, unlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { parseArguments, readJsonFile, runMarketImport, safeImportError } from '../scripts/import-market.js';
import { MarketImportError, parseImportDocument, parseScale } from '../scripts/market-import/document.js';
import { assertLocalMaintenance } from '../scripts/market-import/importer.js';

const scale = parseScale(JSON.parse(await readFile(new URL('./fixtures/market-import.test-scale.json', import.meta.url), 'utf8')));
const fixture = JSON.parse(await readFile(new URL('./fixtures/market-import.test.json', import.meta.url), 'utf8'));
const fresh = () => structuredClone(fixture);

test('import document: TEST fixtures, NULL conservado y orden sin mutar entrada', () => {
    const value = fresh(), before = structuredClone(value);
    value.records.reverse();
    const result = parseImportDocument(value, scale);
    assert.deepEqual(result, before);
    assert.equal(result.records[1]?.requiredLevel, null);
    assert.deepEqual(value.records, before.records.toReversed());
});

test('import document: rechaza campos adicionales, ausentes, tipos y lotes vacíos/excesivos', () => {
    for (const value of [null, [], {}, { ...fresh(), formatVersion: 2 }, { ...fresh(), extra: true },
        { ...fresh(), records: [] }, { ...fresh(), records: Array(1001).fill(fixture.records[0]) }]) {
        assert.throws(() => parseImportDocument(value, scale), MarketImportError);
    }
    for (const field of Object.keys(fixture.records[0])) {
        const value = fresh(); delete value.records[0][field];
        assert.throws(() => parseImportDocument(value, scale), MarketImportError);
    }
    const value = fresh(); value.records[0].extra = 'not accepted';
    assert.throws(() => parseImportDocument(value, scale), MarketImportError);
});

test('import document: rechaza duplicados idénticos o contradictorios, escalas y clasificaciones mezcladas', () => {
    for (const patch of [{}, { requiredLevel: 30 }, { sourceReference: 'TEST:conflict' }]) {
        const value = fresh(); value.records.push({ ...value.records[0], ...patch });
        assert.throws(() => parseImportDocument(value, scale), /duplicada/);
    }
    for (const patch of [{ scaleKey: 'TEST-other' }, { marketKey: 'TEST-other' }, { dataKind: 'demo' }]) {
        const value = fresh(); Object.assign(value.records[0], patch);
        assert.throws(() => parseImportDocument(value, scale), MarketImportError);
    }
});

test('import document: niveles inválidos, procedencia vacía, NUL, DEMO mal clasificado y textos sin normalización', () => {
    for (const requiredLevel of ['90', false, NaN, Infinity, -1, 2147483648, 1.5, 20]) {
        const value = fresh(); value.records[0].requiredLevel = requiredLevel;
        assert.throws(() => parseImportDocument(value, scale), /Nivel/);
    }
    for (const field of ['marketKey', 'skillName', 'scaleKey', 'sourceReference']) {
        for (const invalid of ['', ' ', '\0', ' padded', null, 1, []]) {
            const value = fresh(); value.records[0][field] = invalid;
            assert.throws(() => parseImportDocument(value, scale), MarketImportError);
        }
    }
    const value = fresh(); value.records[0].skillName = '[DEMO] SQL';
    assert.throws(() => parseImportDocument(value, scale), MarketImportError);
});

test('import document: fechas UTC reales, sin normalización implícita ni precisión que se pierda', () => {
    for (const observedAt of ['2026-02-30T00:00:00.000Z', '0000-01-01T00:00:00.000Z', '2026-01-01',
        '2026-01-01T00:00:00Z', '2026-01-01T00:00:00.000001Z', '2026-01-01T00:00:00.000+00:00', 'infinity', null]) {
        const value = fresh(); value.records[0].observedAt = observedAt;
        assert.throws(() => parseImportDocument(value, scale), /observedAt/);
    }
});

test('import scale: comparte validación ordinal del núcleo sin convertir etiquetas ni imponer porcentajes', () => {
    for (const value of [null, {}, { key: 'TEST', levels: [] }, { key: 'TEST', levels: [1, 1] },
        { key: 'TEST', levels: [1, 1.5] }, { key: 'TEST', levels: [1, 'advanced'] },
        { key: 'TEST', levels: [0, 2147483648] }, { key: ' TEST', levels: [0, 1] }]) assert.throws(() => parseScale(value), MarketImportError);
    assert.deepEqual(parseScale({ key: 'TEST', levels: [90, -1, 10] }).levels, [90, -1, 10]);
});

test('import CLI: dry-run por defecto, opciones explícitas y sin argumentos ambiguos', () => {
    const args = ['--file', 'input.json', '--scale', 'scale.json'];
    assert.deepEqual(parseArguments(args), { file: 'input.json', scaleFile: 'scale.json', apply: false, allowUpdates: false });
    assert.equal(parseArguments([...args, '--apply']).apply, true);
    assert.equal(parseArguments([...args, '--apply', '--allow-updates']).allowUpdates, true);
    for (const invalid of [[], ['--file'], [...args, '--apply', '--apply'], [...args, '--file', 'other'],
        [...args, '--allow-updates'], [...args, '--force'], [...args, '--apply=true'], ['--file', '--scale', 'scale.json']]) {
        assert.throws(() => parseArguments(invalid), MarketImportError);
    }
});

test('import CLI: solo entorno local de mantenimiento, sin revelar errores del driver', async () => {
    const env = { NODE_ENV: 'test', PGHOST: '127.0.0.1', PGDATABASE: 'TEST', PGUSER: 'TEST-maintainer', PGPASSWORD: 'TEST-only', DB_SSL_MODE: 'disable' };
    assert.doesNotThrow(() => assertLocalMaintenance(env));
    for (const patch of [{ NODE_ENV: 'production' }, { NODE_ENV: '' }, { PGHOST: 'example.postgres.database.azure.com' },
        { PGHOST: '127.0.0.1.evil.test' }, { PGUSER: 'cvexpert_brecha_app' }]) assert.throws(() => assertLocalMaintenance({ ...env, ...patch }), MarketImportError);
    assert.ok(!safeImportError(new Error('password=TEST-only SELECT secret')).includes('TEST-only'));
    assert.equal(safeImportError(new MarketImportError('Entrada inválida.')), 'Entrada inválida.');
    await assert.rejects(runMarketImport(['--unknown']), MarketImportError);
});

test('import JSON: lectura acotada, UTF-8 y claves repetidas detectadas incluso con escapes', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'cvexpert-import-test-'));
    const file = join(directory, 'input.json');
    try {
        for (const source of ['{"key":1,"key":2}', '{"key":1,"k\\u0065y":2}', '{"nested":{"x":1,"x":2}}', '{broken']) {
            await writeFile(file, source); await assert.rejects(readJsonFile(file), MarketImportError);
        }
        await writeFile(file, '{"a":{"x":1},"b":{"x":2},"value":"{}[]:,\\\""}');
        assert.deepEqual(await readJsonFile(file), { a: { x: 1 }, b: { x: 2 }, value: '{}[]:,"' });
        await writeFile(file, Buffer.from([0xff])); await assert.rejects(readJsonFile(file), /UTF-8/);
        await writeFile(file, ' '.repeat(1024 * 1024 + 1)); await assert.rejects(readJsonFile(file), /1 MiB/);
    } finally { await unlink(file); await rmdir(directory); }
});
