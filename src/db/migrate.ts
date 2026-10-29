import { createHash } from 'node:crypto';
import { readdir, readFile } from 'node:fs/promises';
import type { Pool } from 'pg';
import { inTransaction } from './transaction.js';

const migrationsDirectory = new URL('../../db/migrations/', import.meta.url);

// Permite probar copias de los SQL sin modificar los archivos reales del proyecto.
export async function migrate(pool: Pool, directory: URL = migrationsDirectory): Promise<string[]> {
    const filenames = (await readdir(directory)).filter(name => name.endsWith('.sql')).sort();
    if (filenames.length === 0 || filenames.some(name => !/^\d{3}_[a-z0-9_]+\.sql$/.test(name))) {
        throw new Error('Se requieren migraciones con formato NNN_descripcion.sql.');
    }
    if (new Set(filenames.map(name => name.slice(0, 3))).size !== filenames.length) {
        throw new Error('Hay números de migración duplicados.');
    }
    const migrations = await Promise.all(filenames.map(async name => {
        // Git puede convertir LF a CRLF en Windows; el checksum ignora esa diferencia.
        const sql = (await readFile(new URL(name, directory), 'utf8')).replace(/\r\n/g, '\n');
        return { name, sql, checksum: createHash('sha256').update(sql).digest('hex') };
    }));

    return inTransaction(pool, async client => {
        // Bloqueo transaccional propio del catálogo, liberado también al fallar.
        await client.query('SELECT pg_advisory_xact_lock(834921, 1)');
        await client.query(`CREATE TABLE IF NOT EXISTS public.schema_migrations (
            name text PRIMARY KEY,
            checksum text NOT NULL,
            applied_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP
        )`);
        const applied = await client.query<{ name: string; checksum: string }>(
            'SELECT name, checksum FROM public.schema_migrations ORDER BY name',
        );
        for (const [index, row] of applied.rows.entries()) {
            const file = migrations[index];
            if (!file || row.name !== file.name || row.checksum !== file.checksum) {
                throw new Error('El historial de migraciones fue alterado. Restablece los archivos aplicados; crea otra migración para cambios nuevos.');
            }
        }
        const pending = migrations.slice(applied.rows.length);
        for (const migration of pending) {
            await client.query(migration.sql);
            await client.query('INSERT INTO public.schema_migrations (name, checksum) VALUES ($1, $2)',
                [migration.name, migration.checksum]);
        }
        return pending.map(migration => migration.name);
    });
}
