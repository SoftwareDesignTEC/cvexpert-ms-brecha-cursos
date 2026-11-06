import { createHash } from 'node:crypto';
import type { Pool, PoolClient } from 'pg';
import { getDatabaseConfig } from '../../src/db/config.js';
import { inTransaction } from '../../src/db/transaction.js';
import { CatalogImportError, parseCatalogDocument } from './document.js';

export function assertCatalogMaintenance(env: NodeJS.ProcessEnv): void {
    if (!['development', 'test'].includes(env.NODE_ENV ?? '')
        || !['127.0.0.1', '::1', 'localhost'].includes(env.PGHOST ?? '')
        || Boolean(env.WEBSITE_INSTANCE_ID || env.WEBSITE_SITE_NAME)
        || env.PGUSER === 'cvexpert_brecha_app') {
        throw new CatalogImportError('Solo mantenimiento development/test en loopback; rol HTTP y destinos remotos/Azure prohibidos.');
    }
    getDatabaseConfig(env);
}
export interface CatalogReport {
    mode: 'dry-run' | 'applied' | 'rejected';
    batchId: string;
    reviewedAt: string;
    documentSha256: string;
    provenancePersisted: false;
    skills: { name: string; action: 'insert' | 'existing' }[];
    courses: { url: string; sourceReference: string; action: 'insert' | 'unchanged' | 'conflict'; differences: string[] }[];
    associations: { url: string; skill: string; action: 'insert' | 'existing' | 'conflict' }[];
    conflicts: number;
}
export class CatalogConflictError extends CatalogImportError {
    constructor(public readonly report: CatalogReport) { super('Conflictos: lote rechazado sin escrituras.'); }
}
interface StoredCourse {
    id: number; title: string; platform: string; url: string; isPaid: boolean;
    durationHours: number | null; logoUrl: string | null; skills: string[];
}
export async function importCatalog(pool: Pool, value: unknown, options: { apply?: boolean } = {},
    env: NodeJS.ProcessEnv = process.env): Promise<CatalogReport> {
    assertCatalogMaintenance(env);
    assertCatalogMaintenance({ ...env, PGHOST: String(pool.options.host ?? ''), PGUSER: String(pool.options.user ?? '') });
    parseCatalogDocument(value);
    return inTransaction(pool, async client => {
        // Peer TCP real: también funciona con PostgreSQL desechable publicado por Docker.
        // Un túnel local no se distingue de un servidor local; está prohibido operativamente.
        const peer = (client as unknown as { connection: { stream: { remoteAddress?: string } } }).connection.stream.remoteAddress;
        if (!['127.0.0.1', '::1', '::ffff:127.0.0.1'].includes(peer ?? '')) {
            throw new CatalogImportError('La conexión efectiva no es loopback.');
        }
        await client.query(options.apply
            ? 'SET TRANSACTION ISOLATION LEVEL READ COMMITTED, READ WRITE'
            : 'SET TRANSACTION ISOLATION LEVEL REPEATABLE READ, READ ONLY');
        const access = await client.query<{ allowed: boolean }>(`SELECT
            current_user <> 'cvexpert_brecha_app' AND session_user <> 'cvexpert_brecha_app'
            AND has_schema_privilege(current_user, 'public', 'USAGE')
            AND has_sequence_privilege(current_user, 'public.skills_id_seq', 'USAGE')
            AND has_sequence_privilege(current_user, 'public.courses_id_seq', 'USAGE') AS allowed`);
        if (access.rows[0]?.allowed !== true) throw new CatalogImportError('Sesión SQL sin identidad, destino o permisos de mantenimiento autorizados.');
        const privileges = await client.query<{ allowed: boolean }>(`SELECT bool_and(has_table_privilege(current_user, t, p)) AS allowed
            FROM unnest(ARRAY['public.skills','public.courses','public.course_skills']) t
            CROSS JOIN unnest(ARRAY['SELECT','INSERT','UPDATE']) p`);
        if (privileges.rows[0]?.allowed !== true) throw new CatalogImportError('Faltan permisos de mantenimiento.');
        if (options.apply) {
            await client.query('SELECT pg_advisory_xact_lock(834921, 1)');
            // Bloquea también DML no cooperativo; permite SELECT de HTTP.
            await client.query('LOCK TABLE public.skills, public.courses, public.course_skills IN SHARE ROW EXCLUSIVE MODE');
        }
        const { document, report, skillIds, courses } = await planCatalog(client, value);
        if (options.apply) report.mode = 'applied';
        if (options.apply && report.conflicts) throw new CatalogConflictError({ ...report, mode: 'rejected' });
        if (options.apply) {
            for (const skill of report.skills.filter(s => s.action === 'insert')) {
                const result = await client.query<{ id: number }>('INSERT INTO public.skills (name) VALUES ($1) RETURNING id', [skill.name]);
                if (result.rowCount !== 1) throw new CatalogImportError('La base no confirmó la habilidad.');
                skillIds.set(skill.name, result.rows[0]!.id);
            }
            for (const course of document.courses) {
                if (courses.has(course.url)) continue;
                const result = await client.query<{ id: number }>(`INSERT INTO public.courses
                    (title, platform, url, is_paid, duration_hours, logo_url) VALUES ($1,$2,$3,$4,$5,$6) RETURNING id`,
                [course.title, course.platform, course.url, course.isPaid, course.durationHours, course.logoUrl]);
                if (result.rowCount !== 1) throw new CatalogImportError('La base no confirmó el curso.');
                for (const name of course.skills) {
                    const link = await client.query('INSERT INTO public.course_skills (course_id, skill_id) VALUES ($1,$2)', [result.rows[0]!.id, skillIds.get(name)]);
                    if (link.rowCount !== 1) throw new CatalogImportError('La base no confirmó la asociación.');
                }
            }
        }
        return report;
    });
}

// Shared query-only planner. Callers own transaction, target and identity checks.
export async function planCatalog(client: PoolClient, value: unknown) {
    const document = parseCatalogDocument(value);
    const names = [...new Set([...document.skills, ...document.courses.flatMap(c => c.skills)])];
    const skills = await client.query<{ id: number; name: string }>('SELECT id, name FROM public.skills WHERE name = ANY($1::text[])', [names]);
    const skillIds = new Map(skills.rows.map(s => [s.name, s.id]));
    const declared = new Set(document.skills);
    if (names.some(name => !skillIds.has(name) && !declared.has(name))) {
        throw new CatalogImportError('Habilidad referenciada ausente del lote y del catálogo.');
    }
    const existing = await client.query<StoredCourse>(`SELECT c.id, c.title, c.platform, c.url,
        c.is_paid AS "isPaid", c.duration_hours AS "durationHours", c.logo_url AS "logoUrl",
        ARRAY(SELECT s.name FROM public.course_skills cs JOIN public.skills s ON s.id=cs.skill_id
            WHERE cs.course_id=c.id) AS skills
        FROM public.courses c WHERE c.url = ANY($1::text[])`, [document.courses.map(c => c.url)]);
    const courses = new Map(existing.rows.map(c => [c.url, c]));
    const report: CatalogReport = {
        mode: 'dry-run', batchId: document.batchId, reviewedAt: document.reviewedAt,
        documentSha256: createHash('sha256').update(JSON.stringify(document)).digest('hex'), provenancePersisted: false,
        skills: names.map(name => ({ name, action: skillIds.has(name) ? 'existing' : 'insert' })),
        courses: document.courses.map(course => {
            const before = courses.get(course.url);
            const differences: string[] = [];
            if (before) {
                for (const key of ['title', 'platform', 'isPaid', 'durationHours', 'logoUrl'] as const) {
                    if (before[key] !== course[key]) differences.push(key);
                }
                if (before.skills.length !== course.skills.length || before.skills.some(s => !course.skills.includes(s))) differences.push('skills');
            }
            return { url: course.url, sourceReference: course.sourceReference,
                action: !before ? 'insert' : differences.length ? 'conflict' : 'unchanged', differences };
        }),
        associations: document.courses.flatMap(c => c.skills.map(skill => ({ url: c.url, skill,
            action: !courses.has(c.url) ? 'insert' : courses.get(c.url)!.skills.includes(skill) ? 'existing' : 'conflict' }))),
        conflicts: 0,
    };
    report.conflicts = report.courses.filter(c => c.action === 'conflict').length;

    return { document, report, skillIds, courses };
}
