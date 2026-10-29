import type { Pool } from 'pg';
import { createDatabasePool } from '../db/pool.js';
import type { MarketRequirement } from '../domain/skills-gap.js';
import type { CatalogCourse } from '../models/courses.js';

export interface AnalysisSnapshot { requirements: MarketRequirement[]; courses: CatalogCourse[] }
export interface SkillsGapRepository {
    loadMarket(marketKey: string): Promise<AnalysisSnapshot>;
    close(): Promise<void>;
}

// Una sola instantánea SELECT; no consulta usuarios, no persiste análisis y no
// requiere secuencias, DML ni permisos administrativos para el rol de lectura.
const snapshotSql = `
    WITH requirements AS MATERIALIZED (
        SELECT r.*, s.name FROM public.market_requirements r
        JOIN public.skills s ON s.id = r.skill_id WHERE r.market_key = $1
    )
    SELECT COALESCE((SELECT jsonb_agg(jsonb_build_object(
        'skillName', name, 'level', required_level, 'scaleKey', scale_key,
        'sourceReference', source_reference, 'observedAt', observed_at,
        'dataKind', data_kind) ORDER BY name COLLATE "C") FROM requirements), '[]'::jsonb) AS requirements,
    COALESCE((SELECT jsonb_agg(jsonb_build_object(
        'id', c.id::text, 'title', c.title, 'url', c.url, 'platform', c.platform,
        'logoUrl', c.logo_url, 'durationHours', c.duration_hours, 'isPaid', c.is_paid,
        'skills', ARRAY(SELECT s.name FROM public.course_skills cs JOIN public.skills s ON s.id = cs.skill_id
            WHERE cs.course_id = c.id ORDER BY s.name COLLATE "C")) ORDER BY c.id)
        FROM public.courses c WHERE EXISTS (
            SELECT 1 FROM public.course_skills cs JOIN requirements r ON r.skill_id = cs.skill_id
            WHERE cs.course_id = c.id)), '[]'::jsonb) AS courses
`;

export function createPostgresSkillsGapRepository(poolFactory: () => Pool = createDatabasePool): SkillsGapRepository {
    let pool: Pool | undefined;
    return {
        async loadMarket(marketKey) {
            pool ??= poolFactory();
            const result = await pool.query<AnalysisSnapshot>(snapshotSql, [marketKey]);
            if (!result.rows[0]) throw new Error('Falta la instantánea de análisis.');
            return result.rows[0];
        },
        async close() { await pool?.end(); pool = undefined; },
    };
}
