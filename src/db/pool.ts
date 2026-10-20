import { Pool } from 'pg';
import { getDatabaseConfig } from './config.js';

export function createDatabasePool() {
    const pool = new Pool(getDatabaseConfig());
    // No imprime credenciales ni el objeto de conexión en errores asíncronos.
    pool.on('error', () => {
        console.error('PostgreSQL: se perdió una conexión inactiva del pool.');
    });
    return pool;
}
