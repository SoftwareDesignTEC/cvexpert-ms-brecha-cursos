import type { Pool } from 'pg';
import { createDatabasePool } from '../db/pool.js';
import type { CoursesQuery } from '../models/courses.js';

export interface CourseRecord {
    id: number;
    title: string;
    url: string;
    platform: string;
    logo_url: string | null;
    duration_hours: number | null;
    is_paid: boolean;
    skills: string[];
}

export interface CoursesRepository {
    findPage(query: CoursesQuery): Promise<{ items: CourseRecord[]; totalRecords: number }>;
    close?(): Promise<void>;
}

// Un solo SELECT comparte instantánea para count e items, incluso con escrituras
// concurrentes. El filtro EXISTS no multiplica filas por habilidades asociadas.
const catalogSql = `
    WITH filtered AS MATERIALIZED (
        SELECT c.id, c.title, c.url, c.platform, c.logo_url, c.duration_hours, c.is_paid
        FROM public.courses c
        WHERE ($1::text IS NULL OR c.platform = $1)
          AND ($2::boolean IS NULL OR c.is_paid = $2)
          AND ($3::text IS NULL OR EXISTS (
              SELECT 1 FROM public.course_skills cs
              JOIN public.skills s ON s.id = cs.skill_id
              WHERE cs.course_id = c.id AND s.name = $3
          ))
    ), paged AS (
        SELECT * FROM filtered ORDER BY id ASC LIMIT $4::integer OFFSET $5::bigint
    )
    SELECT (SELECT count(*)::text FROM filtered) AS total_records,
        COALESCE((SELECT jsonb_agg(jsonb_build_object(
            'id', p.id, 'title', p.title, 'url', p.url, 'platform', p.platform,
            'logo_url', p.logo_url, 'duration_hours', p.duration_hours, 'is_paid', p.is_paid,
            'skills', ARRAY(
                SELECT s.name FROM public.course_skills cs
                JOIN public.skills s ON s.id = cs.skill_id
                WHERE cs.course_id = p.id ORDER BY s.name COLLATE "C"
            )
        ) ORDER BY p.id) FROM paged p), '[]'::jsonb) AS items
`;

export function createPostgresCoursesRepository(poolFactory: () => Pool = createDatabasePool): CoursesRepository {
    let pool: Pool | undefined;
    return {
        async findPage(query) {
            // Paginación validada por el controlador. BigInt evita redondear el
            // producto: el máximo offset permitido cabe en bigint de PostgreSQL.
            const offset = (BigInt(query.page) - 1n) * BigInt(query.pageSize);
            pool ??= poolFactory();
            const result = await pool.query<{ total_records: string; items: CourseRecord[] }>(catalogSql, [
                query.platform ?? null, query.isPaid ?? null, query.skillName ?? null,
                query.pageSize, offset.toString(),
            ]);
            const row = result.rows[0];
            if (!row) throw new Error('Falta el resultado del catálogo.');
            const totalRecords = Number(row.total_records);
            if (!Number.isSafeInteger(totalRecords) || totalRecords < 0) {
                throw new Error('Total de catálogo fuera del rango representable.');
            }
            return { items: row.items, totalRecords };
        },
        async close() {
            await pool?.end();
            pool = undefined;
        },
    };
}
