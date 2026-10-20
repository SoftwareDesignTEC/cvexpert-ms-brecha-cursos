import 'dotenv/config';
import { createDatabasePool } from './pool.js';
import { migrate } from './migrate.js';
import { seedDemo } from './seed.js';

async function main() {
    const command = process.argv[2];
    if (!['migrate', 'seed', 'check'].includes(command ?? '')) {
        throw new Error('Usa db:migrate, db:seed o db:check.');
    }
    const pool = createDatabasePool();
    try {
        if (command === 'migrate') {
            const applied = await migrate(pool);
            console.log(applied.length ? `Migraciones aplicadas: ${applied.join(', ')}` : 'Sin migraciones pendientes.');
        } else if (command === 'seed') {
            await seedDemo(pool);
            console.log('Seed DEMO completado; no representa un catálogo real.');
        } else {
            const result = await pool.query(`SELECT current_database() AS database,
                current_setting('server_version') AS version,
                (SELECT count(*)::integer FROM public.courses) AS courses,
                (SELECT count(*)::integer FROM public.skills) AS skills,
                (SELECT count(*)::integer FROM public.course_skills) AS course_skills,
                (SELECT count(*)::integer FROM public.schema_migrations) AS migrations`);
            console.table(result.rows);
            const catalog = await pool.query(`SELECT c.id, c.title, c.is_paid, c.duration_hours,
                coalesce(array_agg(s.name ORDER BY s.name) FILTER (WHERE s.id IS NOT NULL), '{}') AS skills
                FROM public.courses c
                LEFT JOIN public.course_skills cs ON cs.course_id = c.id
                LEFT JOIN public.skills s ON s.id = cs.skill_id
                GROUP BY c.id ORDER BY c.id LIMIT 10`);
            console.table(catalog.rows);
        }
    } finally {
        await pool.end();
    }
}

main().catch((error: unknown) => {
    // Los mensajes del driver pueden incluir datos de la consulta; no se imprimen.
    const code = error && typeof error === 'object' && 'code' in error ? String(error.code) : undefined;
    console.error(code ? `Falló el comando de base de datos (código ${code}).` :
        error instanceof Error ? error.message : 'Falló el comando de base de datos.');
    process.exitCode = 1;
});
