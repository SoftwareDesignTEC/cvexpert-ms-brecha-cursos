import type { Pool } from 'pg';
import type { LevelScale } from '../../src/domain/skills-gap.js';
import { getDatabaseConfig } from '../../src/db/config.js';
import { inTransaction } from '../../src/db/transaction.js';
import { MarketImportError, parseImportDocument, type ImportRecord } from './document.js';

export interface ImportOptions { apply?: boolean; allowUpdates?: boolean }
type StoredRecord = Omit<ImportRecord, 'scaleKey'> & { scaleKey: string | null };
export interface ImportChange { action: 'insert' | 'update' | 'unchanged'; before: StoredRecord | null; after: ImportRecord }
export interface ImportReport { mode: 'dry-run' | 'applied'; marketKey: string; changes: ImportChange[]; requiresAllowUpdates: boolean }

// También se ejecuta antes de crear el pool en la CLI. No permite destinos remotos,
// producción ni el usuario HTTP, aunque solo se solicite dry-run.
export function assertLocalMaintenance(env: NodeJS.ProcessEnv): void {
    if (!['development', 'test'].includes(env.NODE_ENV ?? '')
        || !['127.0.0.1', '::1', 'localhost'].includes(env.PGHOST ?? '')
        || env.PGUSER === 'cvexpert_brecha_app') {
        throw new MarketImportError('Importación permitida solo en development/test, loopback y con credenciales de mantenimiento.');
    }
    getDatabaseConfig(env);
}

export async function importMarketRequirements(pool: Pool, value: unknown, scale: LevelScale,
    options: ImportOptions = {}, env: NodeJS.ProcessEnv = process.env): Promise<ImportReport> {
    assertLocalMaintenance(env);
    assertLocalMaintenance({ ...env, PGHOST: String(pool.options.host ?? ''), PGUSER: String(pool.options.user ?? '') });
    const document = parseImportDocument(value, scale);
    return inTransaction(pool, async client => {
        // El dry-run es READ ONLY también en PostgreSQL: no ejecuta DML que luego revierta.
        if (!options.apply) await client.query('SET TRANSACTION ISOLATION LEVEL REPEATABLE READ, READ ONLY');
        const access = await client.query<{ allowed: boolean }>(`SELECT
            current_user <> 'cvexpert_brecha_app' AND session_user <> 'cvexpert_brecha_app'
            AND has_table_privilege(current_user, 'public.market_requirements', 'SELECT')
            AND has_table_privilege(current_user, 'public.market_requirements', 'INSERT')
            AND has_table_privilege(current_user, 'public.market_requirements', 'UPDATE')
            AND has_table_privilege(current_user, 'public.skills', 'SELECT') AS allowed`);
        if (access.rows[0]?.allowed !== true) throw new MarketImportError('La sesión no tiene permisos de mantenimiento; el rol HTTP está prohibido.');
        if (options.apply) {
            // Mismo lock que migraciones/seed; el lock de tabla protege también
            // frente a DML que no coopere con nuestro advisory lock. SELECT sigue disponible.
            await client.query('SELECT pg_advisory_xact_lock(834921, 1)');
            await client.query('LOCK TABLE public.market_requirements IN SHARE ROW EXCLUSIVE MODE');
        }
        const skills = await client.query<{ id: number; name: string }>(
            'SELECT id, name FROM public.skills WHERE name = ANY($1::text[])', [document.records.map(row => row.skillName)]);
        const ids = new Map(skills.rows.map(row => [row.name, row.id]));
        if (document.records.some(row => !ids.has(row.skillName))) throw new MarketImportError('El lote contiene habilidades inexistentes; no se crean automáticamente.');
        const existing = await client.query<StoredRecord & { preciseDate: boolean }>(`SELECT
            r.market_key AS "marketKey", s.name AS "skillName", r.scale_key AS "scaleKey",
            r.required_level AS "requiredLevel", r.source_reference AS "sourceReference",
            to_char(r.observed_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS "observedAt",
            r.data_kind AS "dataKind", (date_trunc('milliseconds', r.observed_at) = r.observed_at
                AND r.observed_at >= TIMESTAMPTZ '0001-01-01 00:00:00+00'
                AND r.observed_at < TIMESTAMPTZ '10000-01-01 00:00:00+00') AS "preciseDate"
            FROM public.market_requirements r JOIN public.skills s ON s.id = r.skill_id WHERE r.market_key = $1`, [document.marketKey]);
        for (const row of existing.rows) {
            if (row.scaleKey !== null && row.scaleKey !== scale.key) throw new MarketImportError('El contexto ya utiliza otra escala; no se convierte automáticamente.');
            if (row.requiredLevel !== null && !scale.levels.includes(row.requiredLevel)) throw new MarketImportError('El contexto contiene niveles ajenos a la escala suministrada.');
            if (row.dataKind !== document.records[0]!.dataKind) throw new MarketImportError('No se reclasifica un contexto existente entre demo y reference.');
            if (!row.preciseDate) throw new MarketImportError('El contexto contiene fechas con precisión mayor a milisegundos; requiere revisión de mantenimiento.');
        }
        const byName = new Map(existing.rows.map(({ preciseDate: _, ...row }) => [row.skillName, row]));
        const changes = document.records.map(after => {
            const before = byName.get(after.skillName) ?? null;
            const same = before && before.scaleKey === after.scaleKey && before.requiredLevel === after.requiredLevel
                && before.sourceReference === after.sourceReference && before.observedAt === after.observedAt && before.dataKind === after.dataKind;
            const action = !before ? 'insert' : same ? 'unchanged' : 'update';
            if (action === 'update' && after.observedAt <= before!.observedAt) {
                throw new MarketImportError('Una actualización exige una observación posterior; no se sobrescriben evidencias iguales o anteriores.');
            }
            return { action, before, after } as ImportChange;
        });
        const requiresAllowUpdates = changes.some(change => change.action === 'update');
        if (options.apply) {
            if (requiresAllowUpdates && !options.allowUpdates) throw new MarketImportError('Hay actualizaciones: revisa el dry-run y usa --allow-updates junto con --apply.');
            for (const change of changes) {
                const row = change.after;
                const parameters = [row.marketKey, ids.get(row.skillName), row.scaleKey, row.requiredLevel, row.sourceReference, row.observedAt, row.dataKind];
                if (change.action === 'insert') {
                    const result = await client.query(`INSERT INTO public.market_requirements
                        (market_key, skill_id, scale_key, required_level, source_reference, observed_at, data_kind)
                        VALUES ($1, $2, $3, $4, $5, $6, $7)`, parameters);
                    if (result.rowCount !== 1) throw new MarketImportError('La base no confirmó la inserción de una fila.');
                } else if (change.action === 'update') {
                    const result = await client.query(`UPDATE public.market_requirements SET scale_key=$3, required_level=$4,
                        source_reference=$5, observed_at=$6, data_kind=$7 WHERE market_key=$1 AND skill_id=$2`, parameters);
                    if (result.rowCount !== 1) throw new MarketImportError('La base no confirmó la actualización de una fila.');
                }
            }
        }
        return { mode: options.apply ? 'applied' : 'dry-run', marketKey: document.marketKey, changes, requiresAllowUpdates };
    });
}
