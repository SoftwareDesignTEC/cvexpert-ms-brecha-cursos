import { readFileSync } from 'node:fs';
import type { PoolConfig } from 'pg';

export class AdminImportError extends Error {}
export interface Target { server: string; database: string; identity: string; port: number }

export function parseTarget(value: unknown): Target {
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw new AdminImportError('Destino inválido.');
    const t = value as Record<string, unknown>;
    if (Object.keys(t).sort().join(',') !== 'database,identity,port,server'
        || typeof t.server !== 'string' || !/^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.postgres\.database\.azure\.com$/.test(t.server)
        || typeof t.port !== 'number' || !Number.isInteger(t.port) || t.port < 1 || t.port > 65535
        || [t.database, t.identity].some(v => typeof v !== 'string' || !/^[a-zA-Z0-9_@.-]{1,128}$/.test(v as string))
        || (t.identity as string).toLowerCase().split('@')[0] === 'cvexpert_brecha_app') {
        throw new AdminImportError('Destino Azure, base o identidad administrativa no autorizados.');
    }
    return t as unknown as Target;
}

// Separate namespace: neither .env nor PG* choose the administrative target.
export function administrativeConfig(target: Target, env: NodeJS.ProcessEnv): PoolConfig {
    parseTarget(target);
    if (env.ADMIN_IMPORT_SERVER !== target.server || env.ADMIN_IMPORT_DATABASE !== target.database
        || env.ADMIN_IMPORT_IDENTITY !== target.identity || env.ADMIN_IMPORT_PORT !== String(target.port) || !env.ADMIN_IMPORT_PASSWORD
        || env.NODE_TLS_REJECT_UNAUTHORIZED === '0'
        || env.WEBSITE_INSTANCE_ID || env.WEBSITE_SITE_NAME || env.GITHUB_ACTIONS || env.CI || env.TF_BUILD || env.BUILD_BUILDID || env.GITLAB_CI || env.JENKINS_URL) {
        throw new AdminImportError('La configuración no coincide con el destino revisado o no es una sesión administrativa aislada.');
    }
    return {
        host: target.server, port: target.port, database: target.database, user: target.identity,
        password: env.ADMIN_IMPORT_PASSWORD,
        ssl: { rejectUnauthorized: true, servername: target.server,
            ...(env.ADMIN_IMPORT_CA_FILE ? { ca: readFileSync(env.ADMIN_IMPORT_CA_FILE, 'utf8') } : {}) },
        max: 1, connectionTimeoutMillis: 5000, statement_timeout: 15000, idleTimeoutMillis: 5000,
        application_name: 'cvexpert-admin-import-dry-run',
        options: '-c default_transaction_read_only=on -c search_path=pg_catalog -c lock_timeout=5000 -c idle_in_transaction_session_timeout=30000',
    };
}

export function applicationConfig(target: Target, env: NodeJS.ProcessEnv): PoolConfig {
    const config = administrativeConfig(target, env);
    if (target.identity.toLowerCase().split('@')[0] === 'cvexpert_pgadmin') {
        throw new AdminImportError('Se requiere identidad limitada; pgadmin prohibido.');
    }
    return { ...config, application_name: 'cvexpert-admin-import-apply',
        options: config.options!.replace('default_transaction_read_only=on', 'default_transaction_read_only=off') };
}
