import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { readFile, mkdtemp, rmdir, unlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { setTimeout } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { Pool } from 'pg';
import { importMarketRequirements, type ImportReport } from '../../scripts/market-import/importer.js';
import { MarketImportError, parseScale } from '../../scripts/market-import/document.js';
import { getDatabaseConfig } from '../../src/db/config.js';
import { migrate } from '../../src/db/migrate.js';
import { createPostgresSkillsGapRepository } from '../../src/repositories/skills-gap.repository.js';
import { createSkillsGapAnalysisService } from '../../src/services/skills-gap-analysis.service.js';
import { withTestDatabase } from './helpers/test-database.js';

const file = fileURLToPath(new URL('../fixtures/market-import.test.json', import.meta.url));
const scaleFile = fileURLToPath(new URL('../fixtures/market-import.test-scale.json', import.meta.url));
const fixture = JSON.parse(await readFile(file, 'utf8'));
const scale = parseScale(JSON.parse(await readFile(scaleFile, 'utf8')));
const fresh = () => structuredClone(fixture);
const pgCode = (code: string) => (error: unknown) => !!error && typeof error === 'object' && 'code' in error && error.code === code;
const execute = promisify(execFile);

test('importador local con PostgreSQL 17 y credenciales separadas', async t => withTestDatabase(async owner => {
    await migrate(owner);
    await owner.query("INSERT INTO public.skills (name) VALUES ('[TEST] SQL'), ('[TEST] TypeScript')");
    assert.ok(process.env.PG_READONLY_PASSWORD);
    await owner.query('GRANT USAGE ON SCHEMA public TO cvexpert_brecha_app');
    await owner.query('GRANT SELECT ON public.market_requirements, public.skills, public.courses, public.course_skills TO cvexpert_brecha_app');
    const reader = new Pool({ ...getDatabaseConfig(), database: owner.options.database,
        user: 'cvexpert_brecha_app', password: process.env.PG_READONLY_PASSWORD });
    const snapshot = async () => (await owner.query('SELECT * FROM public.market_requirements ORDER BY market_key, skill_id')).rows;
    const cliEnv = { ...process.env, PGDATABASE: String(owner.options.database) };
    const cli = async (args: string[], env = cliEnv) => execute(process.execPath,
        ['--import', 'tsx', 'scripts/import-market.ts', '--file', file, '--scale', scaleFile, ...args],
        { env, timeout: 15000, maxBuffer: 1024 * 1024 });
    const directory = await mkdtemp(join(tmpdir(), 'cvexpert-import-db-test-'));
    const updateFile = join(directory, 'update.json');
    try {
        await t.test('CLI dry-run por defecto no escribe; --apply inserta y repetición es idempotente', async () => {
            const plan = JSON.parse((await cli([])).stdout) as ImportReport;
            assert.equal(plan.mode, 'dry-run');
            assert.deepEqual(plan.changes.map(row => row.action), ['insert', 'insert']);
            assert.equal(plan.changes[1]?.after.requiredLevel, null);
            assert.deepEqual(await snapshot(), []);
            assert.equal(JSON.parse((await cli(['--apply'])).stdout).mode, 'applied');
            const before = await snapshot();
            assert.equal(before.length, 2);
            const again = await importMarketRequirements(owner, fresh(), scale, { apply: true });
            assert.deepEqual(again.changes.map(row => row.action), ['unchanged', 'unchanged']);
            assert.deepEqual(await snapshot(), before);
        });
        await t.test('datos importados alimentan el motor real mediante el rol SELECT', async () => {
            const repo = createPostgresSkillsGapRepository(() => reader);
            const result = await createSkillsGapAnalysisService(repo).analyze(fixture.marketKey, scale,
                fixture.records.map((r: { skillName: string }) => ({ skillName: r.skillName, scaleKey: scale.key, level: 10 })));
            assert.equal(result.status, 'incomplete');
            assert.equal(result.gaps[0]?.skillName, '[TEST] SQL');
            assert.equal(result.gaps[0]?.deficitSteps, 2);
            assert.deepEqual(result.gaps[0]?.courses, []);
            assert.equal(result.unresolved[0]?.marketLevel, null);
            // reader se comparte con los tests de permisos y lo cierra el finally exterior.
        });
        await t.test('actualización requiere opción adicional, muestra before/after y no borra omitidos', async () => {
            const update = fresh(); update.records = [update.records[0]];
            update.records[0].requiredLevel = 30;
            update.records[0].observedAt = '2026-02-01T00:00:00.000Z';
            update.records[0].sourceReference = 'TEST:second-observation';
            const before = await snapshot();
            const plan = await importMarketRequirements(owner, update, scale);
            assert.equal(plan.requiresAllowUpdates, true);
            assert.equal(plan.changes[0]?.before?.requiredLevel, 90);
            assert.equal(plan.changes[0]?.after.requiredLevel, 30);
            assert.deepEqual(await snapshot(), before);
            await assert.rejects(importMarketRequirements(owner, update, scale, { apply: true }), /--allow-updates/);
            assert.deepEqual(await snapshot(), before);
            await writeFile(updateFile, JSON.stringify(update));
            const applied = await execute(process.execPath, ['--import', 'tsx', 'scripts/import-market.ts',
                '--file', updateFile, '--scale', scaleFile, '--apply', '--allow-updates'], { env: cliEnv, timeout: 15000 });
            assert.equal(JSON.parse(applied.stdout).mode, 'applied');
            const after = await snapshot();
            assert.equal(after.length, 2);
            assert.equal(after.find(row => row.required_level === null)?.observed_at.toISOString(), '2026-01-01T00:00:00.000Z');
        });
        await t.test('rechaza observaciones viejas, conflictos de fecha, habilidades inexistentes y niveles inválidos sin cambios', async () => {
            const before = await snapshot();
            for (const patch of [{ observedAt: '2025-01-01T00:00:00.000Z' },
                { observedAt: '2026-02-01T00:00:00.000Z', requiredLevel: 90 },
                { skillName: '[TEST] Missing' }, { requiredLevel: 20 }, { sourceReference: '' }]) {
                const invalid = fresh(); Object.assign(invalid.records[0], patch);
                await assert.rejects(importMarketRequirements(owner, invalid, scale, { apply: true, allowUpdates: true }), MarketImportError);
                assert.deepEqual(await snapshot(), before);
            }
        });
        await t.test('no cambia escala ni clasificación del contexto, incluso con apply y allow-updates', async () => {
            const before = await snapshot();
            for (const mode of ['scale', 'classification']) {
                const invalid = fresh();
                for (const row of invalid.records) {
                    row.observedAt = '2026-03-01T00:00:00.000Z';
                    if (mode === 'scale') row.scaleKey = 'TEST-other-v2'; else row.dataKind = 'demo';
                }
                await assert.rejects(importMarketRequirements(owner, invalid,
                    mode === 'scale' ? { ...scale, key: 'TEST-other-v2' } : scale,
                    { apply: true, allowUpdates: true }), MarketImportError);
            }
            await assert.rejects(importMarketRequirements(owner, fresh(), { ...scale, levels: [10, 90] }), /niveles ajenos/);
            assert.deepEqual(await snapshot(), before);
        });
        await t.test('rollback completo si una restricción PostgreSQL falla después de escribir otra fila', async () => {
            const before = await snapshot(), update = fresh();
            update.records.forEach((row: Record<string, unknown>, index: number) => Object.assign(row, {
                observedAt: '2026-04-01T00:00:00.000Z', requiredLevel: 30,
                sourceReference: index === 0 ? 'TEST:first-write' : 'TEST:reject-second-write',
            }));
            await owner.query(`ALTER TABLE public.market_requirements ADD CONSTRAINT test_import_rollback
                CHECK (source_reference <> 'TEST:reject-second-write')`);
            try {
                await assert.rejects(importMarketRequirements(owner, update, scale, { apply: true, allowUpdates: true }), pgCode('23514'));
                assert.deepEqual(await snapshot(), before);
            } finally { await owner.query('ALTER TABLE public.market_requirements DROP CONSTRAINT test_import_rollback'); }
        });
        await t.test('escala NULL se completa explícitamente y las fechas con microsegundos no se redondean', async () => {
            const input = fresh(); input.marketKey = 'TEST-legacy-scale';
            for (const row of input.records) { row.marketKey = input.marketKey; row.observedAt = '2026-05-01T00:00:00.000Z'; }
            await owner.query(`INSERT INTO public.market_requirements
                SELECT $1, skill_id, NULL, required_level, source_reference, observed_at, data_kind
                FROM public.market_requirements WHERE market_key=$2`, [input.marketKey, fixture.marketKey]);
            const plan = await importMarketRequirements(owner, input, scale);
            assert.equal(plan.changes[0]?.before?.scaleKey, null);
            await importMarketRequirements(owner, input, scale, { apply: true, allowUpdates: true });
            assert.equal((await owner.query('SELECT count(*)::int AS n FROM public.market_requirements WHERE market_key=$1 AND scale_key=$2',
                [input.marketKey, scale.key])).rows[0].n, 2);
            await owner.query("UPDATE public.market_requirements SET observed_at=observed_at + INTERVAL '1 microsecond' WHERE market_key=$1", [input.marketKey]);
            const before = await snapshot();
            await assert.rejects(importMarketRequirements(owner, input, scale, { apply: true, allowUpdates: true }), /precisión/);
            assert.deepEqual(await snapshot(), before);
        });
        await t.test('SQL inyectado es dato literal y no altera tablas', async () => {
            const input = fresh(), key = "TEST-market'; DROP TABLE public.skills; --";
            input.marketKey = key;
            for (const row of input.records) { row.marketKey = key; row.sourceReference = "TEST:source'; DELETE FROM public.courses; --"; }
            await importMarketRequirements(owner, input, scale, { apply: true });
            assert.equal((await owner.query('SELECT count(*)::int AS n FROM public.skills')).rows[0].n, 2);
            assert.equal((await owner.query('SELECT count(*)::int AS n FROM public.market_requirements WHERE market_key=$1', [key])).rows[0].n, 2);
        });
        await t.test('rol HTTP prohibido para importación incluso en dry-run y validación de sesión real', async () => {
            await assert.rejects(importMarketRequirements(reader, fresh(), scale), /mantenimiento/);
            // Metadata de pool falsa no sustituye la identidad autenticada en PostgreSQL.
            const disguised = { options: owner.options, connect: reader.connect.bind(reader) } as unknown as Pool;
            await assert.rejects(importMarketRequirements(disguised, fresh(), scale), /sesión/);
            for (const sql of ['DELETE FROM public.market_requirements', 'UPDATE public.market_requirements SET required_level=0',
                'INSERT INTO public.market_requirements SELECT * FROM public.market_requirements']) await assert.rejects(reader.query(sql), pgCode('42501'));
            const before = await snapshot();
            await assert.rejects(cli(['--apply'], { ...cliEnv, PGUSER: 'cvexpert_brecha_app', PGPASSWORD: process.env.PG_READONLY_PASSWORD }),
                (error: unknown) => !!error && typeof error === 'object' && 'stderr' in error && String(error.stderr).includes('mantenimiento'));
            assert.deepEqual(await snapshot(), before);
        });
        await t.test('dos aplicaciones concurrentes se serializan y la segunda no reescribe', async () => {
            const input = fresh(); input.marketKey = 'TEST-concurrent';
            input.records.forEach((row: Record<string, unknown>) => { row.marketKey = input.marketKey; });
            const blocker = await owner.connect();
            let attempts: Promise<PromiseSettledResult<ImportReport>[]> | undefined;
            let results: PromiseSettledResult<ImportReport>[] = [];
            try {
                await blocker.query('BEGIN'); await blocker.query('SELECT pg_advisory_xact_lock(834921, 1)');
                attempts = Promise.allSettled([importMarketRequirements(owner, input, scale, { apply: true }), importMarketRequirements(owner, input, scale, { apply: true })]);
                const deadline = Date.now() + 5000;
                let waiters = 0;
                do {
                    waiters = (await owner.query(`SELECT count(*)::int AS n FROM pg_locks WHERE locktype='advisory' AND NOT granted
                        AND database=(SELECT oid FROM pg_database WHERE datname=current_database())`)).rows[0].n;
                    if (waiters === 2) break;
                    await setTimeout(20);
                } while (Date.now() < deadline);
                assert.equal(waiters, 2);
            } finally {
                try { await blocker.query('ROLLBACK'); } finally { blocker.release(); if (attempts) results = await attempts; }
            }
            const actions = results.map(result => { if (result.status === 'rejected') throw result.reason;
                return result.value.changes.map(c => c.action).join(','); });
            assert.deepEqual(actions.sort(), ['insert,insert', 'unchanged,unchanged']);
        });
        await t.test('CLI rechaza producción o destino remoto antes de conectar y redacta errores PostgreSQL', async () => {
            const before = await snapshot();
            for (const patch of [{ NODE_ENV: 'production' }, { PGHOST: 'example.postgres.database.azure.com' }]) {
                await assert.rejects(cli(['--apply'], { ...cliEnv, ...patch }),
                    (error: unknown) => !!error && typeof error === 'object' && 'stderr' in error && String(error.stderr).includes('loopback'));
            }
            await assert.rejects(cli([], { ...cliEnv, PGDATABASE: 'TEST_nonexistent_database', PGPASSWORD: 'TEST-credential-must-not-appear' }),
                (error: unknown) => !!error && typeof error === 'object' && 'stderr' in error
                    && String(error.stderr).includes('no se publican detalles') && !String(error.stderr).includes('TEST-credential-must-not-appear'));
            assert.deepEqual(await snapshot(), before);
        });
    } finally {
        await reader.end();
        try { await unlink(updateFile); } catch (error) { if (!(error && typeof error === 'object' && 'code' in error && error.code === 'ENOENT')) throw error; }
        await rmdir(directory);
    }
}));
