import { readFileSync } from 'node:fs';
import type { PoolConfig } from 'pg';

// No lee .env ni crea conexiones al importar; también permite pruebas sin PostgreSQL.
export function getDatabaseConfig(env: NodeJS.ProcessEnv = process.env): PoolConfig {
    function required(name: string): string {
        const value = env[name];
        if (!value || !value.trim()) throw new Error(`Falta la variable ${name}.`);
        return value;
    }

    const portText = env.PGPORT ?? '5433';
    const port = Number(portText);
    if (!/^\d+$/.test(portText) || !Number.isInteger(port) || port < 1 || port > 65535) {
        throw new Error('PGPORT debe ser un entero entre 1 y 65535.');
    }

    const mode = env.DB_SSL_MODE ?? 'verify-full';
    if (mode !== 'disable' && mode !== 'verify-full') {
        throw new Error('DB_SSL_MODE debe ser disable o verify-full.');
    }
    const localEnvironment = env.NODE_ENV === 'development' || env.NODE_ENV === 'test';
    if (mode === 'disable' && !localEnvironment) {
        throw new Error('TLS solo puede deshabilitarse en development o test.');
    }
    if (mode === 'disable' && env.PGSSLROOTCERT) {
        throw new Error('PGSSLROOTCERT requiere DB_SSL_MODE=verify-full.');
    }

    return {
        host: required('PGHOST'),
        port,
        database: required('PGDATABASE'),
        user: required('PGUSER'),
        password: required('PGPASSWORD'),
        ssl: mode === 'disable' ? false : {
            rejectUnauthorized: true,
            ...(env.PGSSLROOTCERT ? { ca: readFileSync(env.PGSSLROOTCERT, 'utf8') } : {}),
        },
        max: 5,
        connectionTimeoutMillis: 5000,
        idleTimeoutMillis: 30000,
        statement_timeout: 15000,
        application_name: 'cvexpert-brecha-cursos',
        options: '-c search_path=public',
    };
}
