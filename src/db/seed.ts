import { readFile } from 'node:fs/promises';
import type { Pool } from 'pg';
import { inTransaction } from './transaction.js';

export async function seedDemo(pool: Pool, environment = process.env.NODE_ENV): Promise<void> {
    if (environment !== 'development' && environment !== 'test') {
        throw new Error('El seed demo solo se permite en development o test.');
    }
    const sql = await readFile(new URL('../../db/seeds/demo.sql', import.meta.url), 'utf8');
    await inTransaction(pool, async client => {
        await client.query('SELECT pg_advisory_xact_lock(834921, 1)');
        await client.query(sql);
    });
}
