import assert from 'node:assert/strict';
import { mkdtemp, readFile, readdir, rmdir, unlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, sep } from 'node:path';
import { setTimeout } from 'node:timers/promises';
import { test } from 'node:test';
import { pathToFileURL } from 'node:url';
import type { Pool } from 'pg';
import { migrate } from '../../src/db/migrate.js';
import { withTestDatabase } from './helpers/test-database.js';

test('ejecutor de migraciones en una base desechable', async t => withTestDatabase(async pool => {
    const directory = await mkdtemp(join(tmpdir(), 'cvexpert-migrations-'));
    const url = pathToFileURL(directory + sep);
    const firstName = '001_create_catalog.sql';
    const history = async () => (await pool.query(
        'SELECT name, checksum, applied_at FROM public.schema_migrations ORDER BY name',
    )).rows;
    try {
        const original = await readFile(new URL('../../db/migrations/001_create_catalog.sql', import.meta.url), 'utf8');
        await writeFile(new URL(firstName, url), original);

        await t.test('primera aplicación crea el catálogo y registra el checksum', async () => {
            assert.deepEqual(await migrate(pool, url), [firstName]);
            const tables = await pool.query(`SELECT tablename FROM pg_tables WHERE schemaname = 'public' ORDER BY tablename`);
            assert.deepEqual(tables.rows.map(row => row.tablename), ['course_skills', 'courses', 'schema_migrations', 'skills']);
            const rows = await history();
            assert.equal(rows.length, 1);
            assert.equal(rows[0].name, firstName);
            assert.match(rows[0].checksum, /^[a-f0-9]{64}$/);
        });

        await t.test('segunda ejecución no reaplica ni modifica el historial', async () => {
            const before = await history();
            assert.deepEqual(await migrate(pool, url), []);
            assert.deepEqual(await history(), before);
        });

        await t.test('detecta contenido alterado en una migración aplicada', async () => {
            const before = await history();
            try {
                await writeFile(new URL(firstName, url), original + '\n-- Contenido alterado solo en la copia de prueba.\n');
                await assert.rejects(migrate(pool, url), /historial de migraciones fue alterado/);
                assert.deepEqual(await history(), before);
            } finally {
                await writeFile(new URL(firstName, url), original);
            }
        });

        await t.test('una migración fallida revierte el lote pendiente completo, incluido el DDL', async () => {
            const before = await history();
            const second = new URL('002_rollback_probe.sql', url);
            const third = new URL('003_failure_probe.sql', url);
            try {
                await writeFile(second, 'CREATE TABLE public.rollback_probe (id integer PRIMARY KEY);');
                await writeFile(third, `CREATE TABLE public.partial_probe (id integer);
                    INSERT INTO public.rollback_probe VALUES (1);
                    SELECT 1 / 0;`);
                await assert.rejects(migrate(pool, url), (error: unknown) =>
                    !!error && typeof error === 'object' && 'code' in error && error.code === '22012');
                const result = await pool.query(`SELECT to_regclass('public.rollback_probe') AS earlier,
                    to_regclass('public.partial_probe') AS partial`);
                assert.deepEqual(result.rows, [{ earlier: null, partial: null }]);
                assert.deepEqual(await history(), before);
                // La migración previamente aplicada sigue disponible.
                assert.equal((await pool.query('SELECT count(*)::integer AS count FROM public.courses')).rows[0].count, 0);
            } finally {
                await unlink(second);
                await unlink(third);
            }
        });

        await t.test('dos ejecutores esperan el lock y aplican la migración una sola vez', async () => {
            await writeFile(new URL('002_concurrent.sql', url), `CREATE TABLE public.concurrency_probe (id integer PRIMARY KEY);
                INSERT INTO public.concurrency_probe VALUES (1);`);
            const blocker = await pool.connect();
            let attempts: Promise<PromiseSettledResult<string[]>[]> | undefined;
            let results: PromiseSettledResult<string[]>[] = [];
            try {
                await blocker.query('BEGIN');
                await blocker.query('SELECT pg_advisory_xact_lock(834921, 1)');
                // allSettled observa inmediatamente cualquier rechazo; no quedan promesas sueltas.
                attempts = Promise.allSettled([migrate(pool, url), migrate(pool, url)]);
                const deadline = Date.now() + 5000;
                let waiters = 0;
                do {
                    const locks = await pool.query(`SELECT count(*)::integer AS count FROM pg_locks
                        WHERE locktype = 'advisory' AND NOT granted
                        AND database = (SELECT oid FROM pg_database WHERE datname = current_database())`);
                    waiters = locks.rows[0].count;
                    if (waiters === 2) break;
                    await setTimeout(20);
                } while (Date.now() < deadline);
                assert.equal(waiters, 2, 'Ambos ejecutores deben esperar el bloqueo antes de modificar el esquema.');
            } finally {
                try {
                    await blocker.query('ROLLBACK');
                } finally {
                    blocker.release();
                    if (attempts) results = await attempts;
                }
            }
            const applied = results.map(result => {
                if (result.status === 'rejected') throw result.reason;
                return result.value;
            });
            assert.deepEqual(applied.sort((a, b) => a.length - b.length), [[], ['002_concurrent.sql']]);
            assert.equal((await pool.query('SELECT count(*)::integer AS count FROM public.concurrency_probe')).rows[0].count, 1);
            assert.deepEqual((await history()).map(row => row.name), [firstName, '002_concurrent.sql']);
        });
    } finally {
        // Directorio creado por mkdtemp; solo quitamos sus archivos y luego el directorio vacío.
        for (const filename of await readdir(directory)) await unlink(join(directory, filename));
        await rmdir(directory);
    }
}));

test('cierra el pool y elimina su base desechable aunque pool.connect falle', async t => {
    const failure = new Error('Fallo de conexión simulado');
    let testPool: Pool | undefined;
    await assert.rejects(withTestDatabase(async pool => {
        testPool = pool;
        t.mock.method(pool, 'connect', () => Promise.reject(failure));
        await pool.connect();
    }), error => error === failure);
    assert.ok(testPool);
    assert.equal(testPool.ended, true);
});
