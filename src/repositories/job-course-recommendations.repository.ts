import type { Pool } from 'pg';
import { createDatabasePool } from '../db/pool.js';
import { inTransaction } from '../db/transaction.js';
import { normalizeJobSkillName } from '../domain/job-skills-gap.js';
import type { CatalogCourse } from '../models/courses.js';

export interface CatalogSkillMatch {
    catalogMatch: 'matched' | 'ambiguous' | 'not_found';
    courses: CatalogCourse[];
}

export interface JobCourseRecommendationsRepository {
    findBySkillKeys(keys: ReadonlySet<string>): Promise<ReadonlyMap<string, CatalogSkillMatch>>;
    close?(): Promise<void>;
}

const coursesPerSkill = 5;
const fixtureMarker = '\\[(demo|test)\\]';
const fixtureUrl = '^https?://([^/?#@]*@)?([^/?#:.]+\\.)*example\\.(com|net|org)\\.?([:/?#]|$)';

// El índice (skill_id, course_id) permite recorrer los candidatos por ID y
// aplicar el límite por habilidad después de excluir los datos ficticios.
const coursesSql = `
    SELECT requested.skill_id, c.id::text AS id, c.title, c.platform, c.url,
        c.logo_url AS "logoUrl", c.duration_hours AS "durationHours", c.is_paid AS "isPaid",
        ARRAY(
            SELECT s.name FROM public.course_skills cs
            JOIN public.skills s ON s.id = cs.skill_id
            WHERE cs.course_id = c.id ORDER BY s.name COLLATE "C"
        ) AS skills
    FROM unnest($1::integer[]) AS requested(skill_id)
    CROSS JOIN LATERAL (
        SELECT candidate.*
        FROM public.course_skills link
        JOIN public.courses candidate ON candidate.id = link.course_id
        WHERE link.skill_id = requested.skill_id
          AND candidate.title !~* $3 AND candidate.platform !~* $3
          AND candidate.url !~* $3 AND candidate.url !~* $4
          AND COALESCE(candidate.logo_url, '') !~* $3 AND COALESCE(candidate.logo_url, '') !~* $4
          AND NOT EXISTS (
              SELECT 1 FROM public.course_skills other
              JOIN public.skills s ON s.id = other.skill_id
              WHERE other.course_id = candidate.id AND s.name ~* $3
          )
        ORDER BY link.course_id
        LIMIT $2::integer
    ) c
    ORDER BY requested.skill_id, c.id
`;

export function createPostgresJobCourseRecommendationsRepository(
    poolFactory: () => Pool = createDatabasePool,
): JobCourseRecommendationsRepository {
    let pool: Pool | undefined;
    return {
        async findBySkillKeys(keys) {
            const matches = new Map<string, CatalogSkillMatch>();
            if (keys.size === 0) return matches;
            pool ??= poolFactory();
            return inTransaction(pool, async client => {
                // Ambas lecturas comparten la misma instantánea del catálogo.
                await client.query('SET TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY');
                const { rows: skills } = await client.query<{ id: number; name: string }>(
                    'SELECT id, name FROM public.skills',
                );
                const uniqueIds = new Map<string, number>();
                for (const { id, name } of skills) {
                    const { key } = normalizeJobSkillName(name);
                    if (!keys.has(key)) continue;
                    if (matches.has(key)) {
                        matches.set(key, { catalogMatch: 'ambiguous', courses: [] });
                        uniqueIds.delete(key);
                    } else {
                        matches.set(key, { catalogMatch: 'matched', courses: [] });
                        uniqueIds.set(key, id);
                    }
                }
                if (uniqueIds.size === 0) return matches;
                const keysById = new Map([...uniqueIds].map(([key, id]) => [id, key]));
                const { rows } = await client.query<CatalogCourse & { skill_id: number }>(coursesSql, [
                    [...keysById.keys()], coursesPerSkill, fixtureMarker, fixtureUrl,
                ]);
                for (const { skill_id, ...course } of rows) {
                    matches.get(keysById.get(skill_id)!)!.courses.push(course);
                }
                return matches;
            });
        },
        async close() {
            await pool?.end();
            pool = undefined;
        },
    };
}
