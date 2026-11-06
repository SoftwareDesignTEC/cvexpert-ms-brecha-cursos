import type { Pool, PoolClient } from 'pg';
import { AdminImportError, type Target } from './config.js';
import { prepareInput, verifySession, type PreparedInput } from './planner.js';
import { planCatalog } from '../catalog-import/importer.js';
import { planMarketRequirements } from '../market-import/importer.js';
import { digest, type Approval } from './approval.js';

export async function jointPlan(client: PoolClient, input: PreparedInput) {
    const c = await planCatalog(client, input.catalog);
    if (c.report.conflicts) throw new AdminImportError('Conflicto en cursos existentes; no se sobrescriben.');
    const m = await planMarketRequirements(client, input.market, input.scale,
        c.report.skills.filter(s => s.action === 'insert').map(s => s.name));
    // Incluye filas omitidas del documento: cualquier divergencia del contexto requiere revisión.
    const context = await client.query(`SELECT r.*, s.name AS skill_name FROM public.market_requirements r
        JOIN public.skills s ON s.id=r.skill_id WHERE market_key=$1 ORDER BY s.name COLLATE "C"`, [input.market.marketKey]);
    return { catalog: c.report, market: { changes: m.changes, context: context.rows } };
}
export type JointPlan = Awaited<ReturnType<typeof jointPlan>>;

async function verifyContents(client: PoolClient, input: PreparedInput) {
    const c = await planCatalog(client, input.catalog);
    const m = await planMarketRequirements(client, input.market, input.scale);
    if (c.report.conflicts || c.report.skills.some(s => s.action !== 'existing')
        || c.report.courses.some(c => c.action !== 'unchanged') || c.report.associations.some(a => a.action !== 'existing')
        || m.changes.some(c => c.action !== 'unchanged')) throw new AdminImportError('La verificación de contenido completo falló.');
    return { skills: c.report.skills.length, courses: c.report.courses.length,
        associations: c.report.associations.length, requirements: m.changes.length, inputSha256: digest(input) };
}
export class CommitUncertainError extends AdminImportError {}

async function existingRun(client: PoolClient, approval: Approval, input: PreparedInput) {
    const p = approval.payload;
    const result = await client.query('SELECT * FROM public.admin_import_runs WHERE execution_id=$1', [p.executionId]);
    const row = result.rows[0];
    if (!row) return null;
    if (row.approval_sha256 !== digest(approval) || row.batch_sha256 !== p.inputSha256
        || digest(row.target) !== digest(p.target) || row.applied_by !== p.target.identity
        || digest(row.approval) !== digest(approval) || digest(row.input_document) !== digest(input)) {
        throw new AdminImportError('Identificador de ejecución ya utilizado con otra aprobación.');
    }
    const verification = await verifyContents(client, input);
    if (digest(verification) !== digest(row.verification)) throw new AdminImportError('Evidencia de ejecución inconsistente.');
    return { status: 'applied' as const, executionId: p.executionId, replay: true, verification };
}

// La CLI valida firma, archivos y entorno antes de crear el pool. Sin switches de prueba/TLS.
export async function applyApproved(pool: Pool, approval: Approval, value: PreparedInput) {
    const input = prepareInput(value.catalog, value.market, value.scale), p = approval.payload;
    const client = await pool.connect();
    let committing = false, broken = false;
    try {
        await client.query('BEGIN ISOLATION LEVEL READ COMMITTED READ WRITE');
        await client.query('SELECT pg_advisory_xact_lock(834921, 1)');
        await verifySession(client, p.target, 'apply');
        await client.query('SELECT public.lock_admin_import_tables()');
        await verifySession(client, p.target, 'apply');
        const prior = await existingRun(client, approval, input);
        if (prior) { await client.query('ROLLBACK'); return prior; }
        if (Date.parse(p.expiresAt) <= Date.now()) throw new AdminImportError('Aprobación venció mientras esperaba el bloqueo.');
        const plan = await jointPlan(client, input);
        if (p.inputSha256 !== digest(input) || digest(plan) !== p.planSha256 || digest(p.plan) !== p.planSha256) {
            throw new AdminImportError('Divergencia del plan autorizado; requiere nueva revisión.');
        }
        if (plan.market.changes.some(c => c.action === 'update') && p.review.marketUpdates !== true) {
            throw new AdminImportError('Actualizaciones de mercado no autorizadas explícitamente.');
        }
        const c = await planCatalog(client, input.catalog);
        for (const s of c.report.skills.filter(s => s.action === 'insert')) {
            const r = await client.query('INSERT INTO public.skills(name) VALUES ($1) RETURNING id', [s.name]);
            if (r.rowCount !== 1) throw new AdminImportError('Inserción de habilidad incompleta.');
            c.skillIds.set(s.name, r.rows[0].id);
        }
        for (const course of c.document.courses) {
            if (c.courses.has(course.url)) continue;
            const r = await client.query(`INSERT INTO public.courses(title,platform,url,is_paid,duration_hours,logo_url)
                VALUES ($1,$2,$3,$4,$5,$6) RETURNING id`,
            [course.title, course.platform, course.url, course.isPaid, course.durationHours, course.logoUrl]);
            if (r.rowCount !== 1) throw new AdminImportError('Inserción de curso incompleta.');
            for (const name of course.skills) {
                const link = await client.query('INSERT INTO public.course_skills(course_id,skill_id) VALUES ($1,$2)', [r.rows[0].id, c.skillIds.get(name)]);
                if (link.rowCount !== 1) throw new AdminImportError('Asociación incompleta.');
            }
        }
        // Resolver habilidades recién persistidas antes de escribir mercado.
        const m = await planMarketRequirements(client, input.market, input.scale);
        if (digest(m.changes) !== digest(plan.market.changes)) throw new AdminImportError('Mercado divergió durante el lote.');
        for (const change of m.changes) {
            if (change.action === 'unchanged') continue;
            const r = change.after;
            const args = [r.marketKey, m.ids.get(r.skillName), r.scaleKey, r.requiredLevel, r.sourceReference, r.observedAt, r.dataKind];
            const result = await client.query(change.action === 'insert'
                ? `INSERT INTO public.market_requirements(market_key,skill_id,scale_key,required_level,source_reference,observed_at,data_kind)
                    VALUES ($1,$2,$3,$4,$5,$6,$7)`
                : `UPDATE public.market_requirements SET scale_key=$3,required_level=$4,source_reference=$5,observed_at=$6,data_kind=$7
                    WHERE market_key=$1 AND skill_id=$2`, args);
            if (result.rowCount !== 1) throw new AdminImportError('Escritura de mercado incompleta.');
        }
        const verification = await verifyContents(client, input);
        const audit = await client.query(`INSERT INTO public.admin_import_runs
            (execution_id,approval_sha256,batch_sha256,target,approval,input_document,verification) VALUES ($1,$2,$3,$4,$5,$6,$7)`,
        [p.executionId, digest(approval), p.inputSha256, JSON.stringify(p.target), JSON.stringify(approval), JSON.stringify(input), JSON.stringify(verification)]);
        if (audit.rowCount !== 1) throw new AdminImportError('Evidencia durable incompleta.');
        committing = true;
        await client.query('COMMIT');
        return { status: 'applied' as const, executionId: p.executionId, replay: false, verification };
    } catch (error) {
        if (committing) { broken = true; throw new CommitUncertainError('COMMIT incierto: ejecutar db:admin:verify con la misma aprobación.'); }
        try { await client.query('ROLLBACK'); } catch { broken = true; }
        throw error;
    } finally { client.release(broken); }
}

export async function verifyApproved(pool: Pool, reader: Target, approval: Approval, input: PreparedInput) {
    if (reader.server !== approval.payload.target.server || reader.database !== approval.payload.target.database
        || reader.port !== approval.payload.target.port || reader.identity !== approval.payload.readerIdentity) {
        throw new AdminImportError('Destino lector distinto de la aprobación.');
    }
    const client = await pool.connect();
    try {
        await client.query('SELECT pg_advisory_lock(834921, 1)');
        await client.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
        await verifySession(client, reader);
        const prior = await existingRun(client, approval, prepareInput(input.catalog, input.market, input.scale));
        await client.query('COMMIT');
        return prior ?? { status: 'not-applied' as const, executionId: approval.payload.executionId };
    } catch (error) { await client.query('ROLLBACK').catch(() => {}); throw error; }
    finally {
        try { await client.query('SELECT pg_advisory_unlock(834921, 1)'); client.release(); }
        catch { client.release(true); }
    }
}
