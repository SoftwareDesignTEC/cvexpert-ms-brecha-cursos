import 'dotenv/config';
import { randomUUID } from 'node:crypto';
import { Pool } from 'pg';
import { getDatabaseConfig } from '../../../src/db/config.js';

// Dueño del ciclo de vida: el pool se cierra aunque work falle en pool.connect().
export async function withTestDatabase<T>(work: (pool: Pool) => Promise<T>): Promise<T> {
    if (process.env.NODE_ENV !== 'development' && process.env.NODE_ENV !== 'test') {
        throw new Error('Las bases desechables solo se permiten en development o test.');
    }
    const config = getDatabaseConfig();
    if (!['127.0.0.1', 'localhost', '::1'].includes(String(config.host))) {
        throw new Error('Las pruebas desechables requieren PostgreSQL en loopback local.');
    }
    const database = `cvexpert_test_${randomUUID().replaceAll('-', '')}`;
    // Los identificadores SQL no aceptan $1. Solo interpolamos este nombre generado,
    // limitado a caracteres seguros, nunca PGDATABASE ni una entrada del usuario.
    if (!/^cvexpert_test_[a-f0-9]{32}$/.test(database) || database === config.database) {
        throw new Error('Nombre inseguro para la base desechable.');
    }
    const identifier = `"${database}"`;
    const admin = new Pool({ ...config, database: 'postgres', max: 1 });
    let created = false;
    try {
        await admin.query(`CREATE DATABASE ${identifier} TEMPLATE template0`);
        created = true;
        const pool = new Pool({ ...config, database });
        try {
            return await work(pool);
        } finally {
            await pool.end();
        }
    } finally {
        try {
            if (created) {
                // Sin FORCE: no mata sesiones. Solo elimina la base creada aquí.
                await admin.query(`DROP DATABASE ${identifier}`);
            }
        } finally {
            await admin.end();
        }
    }
}
