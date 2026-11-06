import { createHash, randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import type { Pool, PoolClient } from 'pg';
import type { TLSSocket } from 'node:tls';
import { parseCatalogDocument, CatalogImportError } from '../catalog-import/document.js';
import { planCatalog } from '../catalog-import/importer.js';
import { parseImportDocument, parseScale, MarketImportError } from '../market-import/document.js';
import { planMarketRequirements } from '../market-import/importer.js';
import { inTransaction } from '../../src/db/transaction.js';
import { AdminImportError, parseTarget, type Target } from './config.js';

export const sha256 = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex');
export function prepareInput(catalog: unknown, market: unknown, scaleValue: unknown) {
    const scale = parseScale(scaleValue);
    const input = { catalog: parseCatalogDocument(catalog), market: parseImportDocument(market, scale), scale };
    if (input.market.records.some(r => r.dataKind !== 'reference')) throw new AdminImportError('El procedimiento administrativo rechaza requisitos demo.');
    return input;
}
export type PreparedInput = ReturnType<typeof prepareInput>;

export async function verifySession(client: PoolClient, target: Target) {
    parseTarget(target);
    // A verified TLS certificate binds this socket to the exact reviewed FQDN.
    const stream = (client as unknown as { connection: { stream: TLSSocket } }).connection.stream;
    if (!stream.encrypted || !stream.authorized || stream.servername !== target.server
        || !['TLSv1.2', 'TLSv1.3'].includes(stream.getProtocol() ?? '')) {
        throw new AdminImportError('TLS verificado e identidad del servidor requeridos.');
    }
    const result = await client.query(`SELECT current_database() AS database, current_user AS identity,
        session_user AS session_identity, current_setting('transaction_read_only') AS read_only,
        current_setting('transaction_isolation') AS isolation,
        inet_server_addr()::text AS server_address, inet_server_port() AS server_port,
        EXISTS (SELECT 1 FROM pg_catalog.pg_stat_ssl WHERE pid=pg_backend_pid() AND ssl) AS tls,
        NOT EXISTS (SELECT 1 FROM pg_catalog.pg_roles WHERE (rolname=current_user OR pg_has_role(current_user, oid, 'MEMBER'))
            AND (rolsuper OR rolcreatedb OR rolcreaterole OR rolreplication OR rolbypassrls)) AS restricted,
        has_schema_privilege(current_user, 'public', 'USAGE')
            AND NOT has_schema_privilege(current_user, 'public', 'CREATE') AS schema_allowed,
        (SELECT bool_and(has_table_privilege(current_user, t, 'SELECT'))
            FROM unnest(ARRAY['public.skills','public.courses','public.course_skills',
                'public.market_requirements','public.schema_migrations']) t) AS can_read,
        (SELECT bool_and(NOT has_table_privilege(current_user, t, p))
            FROM unnest(ARRAY['public.skills','public.courses','public.course_skills',
                'public.market_requirements','public.schema_migrations']) t
            CROSS JOIN unnest(ARRAY['INSERT','UPDATE','DELETE','TRUNCATE','REFERENCES','TRIGGER']) p) AS no_dml,
        NOT has_table_privilege(current_user, 'public.user_skill_snapshots', 'SELECT,INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER') AS no_snapshots,
        NOT EXISTS (SELECT 1 FROM pg_catalog.pg_class c JOIN pg_catalog.pg_namespace n ON n.oid=c.relnamespace
            WHERE n.nspname='public' AND c.relname=ANY(ARRAY['skills','courses','course_skills','market_requirements','schema_migrations'])
                AND (c.relkind <> 'r' OR c.relrowsecurity)) AS ordinary_tables`);
    const s = result.rows[0];
    if (!s || s.database !== target.database || s.identity !== target.identity || s.session_identity !== target.identity
        || [s.identity, s.session_identity].some(v => String(v).toLowerCase().split('@')[0] === 'cvexpert_brecha_app')
        || s.read_only !== 'on' || s.isolation !== 'repeatable read' || s.server_port !== target.port
        || !s.server_address || !s.tls || !s.restricted || !s.schema_allowed || !s.can_read || !s.no_dml || !s.no_snapshots || !s.ordinary_tables) {
        throw new AdminImportError('Servidor, base, sesión o permisos mínimos no coinciden con la revisión.');
    }
    // Pin the historical migration checksums; do not run the migrator or read user snapshots.
    const expected = await Promise.all(['001_create_catalog.sql', '002_create_market_requirements.sql', '003_create_user_skill_snapshots.sql']
        .map(async name => ({ name, checksum: createHash('sha256').update((await readFile(new URL(`../../db/migrations/${name}`, import.meta.url), 'utf8')).replace(/\r\n/g, '\n')).digest('hex') })));
    const history = await client.query('SELECT name, checksum FROM public.schema_migrations ORDER BY name');
    if (JSON.stringify(history.rows) !== JSON.stringify(expected)) throw new AdminImportError('Historial de migraciones distinto del revisado; detener y revisar.');
    return { ...target, serverAddress: s.server_address as string, tls: stream.getProtocol(),
        certificateVerified: true, readOnly: true, permissions: 'select-only', migrations: expected };
}

export async function planAdministrativeImport(pool: Pool, target: Target, value: PreparedInput) {
    // Revalidate even when called outside the CLI.
    const input = prepareInput(value.catalog, value.market, value.scale);
    return inTransaction(pool, async client => {
        await client.query('SET TRANSACTION ISOLATION LEVEL REPEATABLE READ, READ ONLY');
        const verified = await verifySession(client, target);
        const conflicts: { scope: 'catalog' | 'market'; reason: string }[] = [];
        let catalog = null, market = null;
        try { catalog = (await planCatalog(client, input.catalog)).report; }
        catch (error) {
            if (!(error instanceof CatalogImportError)) throw error;
            conflicts.push({ scope: 'catalog', reason: error.message });
        }
        try {
            const p = await planMarketRequirements(client, input.market, input.scale);
            market = { marketKey: p.document.marketKey, changes: p.changes, requiresUpdateReview: p.requiresAllowUpdates };
        } catch (error) {
            if (!(error instanceof MarketImportError)) throw error;
            conflicts.push({ scope: 'market', reason: error.message });
        }
        return {
            formatVersion: 1, reportId: randomUUID(), generatedAt: new Date().toISOString(), mode: 'dry-run',
            target: verified, inputSha256: sha256(input), provenancePersisted: false,
            provenance: { batchId: input.catalog.batchId, reviewedAt: input.catalog.reviewedAt,
                catalogSha256: sha256(input.catalog), marketSha256: sha256(input.market), scaleSha256: sha256(input.scale) },
            catalog, market, conflicts,
            summary: {
                catalogInserts: catalog ? [...catalog.skills, ...catalog.courses, ...catalog.associations].filter(r => r.action === 'insert').length : null,
                catalogExisting: catalog ? [...catalog.skills, ...catalog.courses, ...catalog.associations].filter(r => r.action === 'existing' || r.action === 'unchanged').length : null,
                marketInserts: market?.changes.filter(r => r.action === 'insert').length ?? null,
                marketExisting: market?.changes.filter(r => r.action === 'unchanged').length ?? null,
                marketUpdatesRequiringReview: market?.changes.filter(r => r.action === 'update').length ?? null,
                conflicts: conflicts.length + (catalog?.conflicts ?? 0),
            },
            // A clean preview never authorizes writes; this release has no apply capability.
            applyAvailable: false,
        };
    });
}
