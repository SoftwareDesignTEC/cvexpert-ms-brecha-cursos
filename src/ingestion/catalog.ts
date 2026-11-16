import type { PoolClient } from 'pg';
import { normalizeJobSkillName } from '../domain/job-skills-gap.js';
import { IngestError, officialCourseUrl, vocabulary, type AutomaticCourse, type Discovery } from './providers.js';

export async function verifyIngestIdentity(client: PoolClient) {
    const identity = (await client.query(`SELECT current_user AS effective,session_user AS login,
        r.rolsuper OR r.rolcreatedb OR r.rolcreaterole OR r.rolbypassrls OR r.rolreplication OR r.rolinherit AS elevated,
        (SELECT count(*) FROM pg_auth_members WHERE member=r.oid) AS memberships,
        has_database_privilege(current_user,current_database(),'CREATE') OR has_schema_privilege(current_user,'public','CREATE') AS ddl,
        (SELECT count(*) FROM pg_database WHERE datname=current_database() AND datdba=r.oid) AS owned
        FROM pg_roles r WHERE rolname=current_user`)).rows[0];
    if (identity?.effective !== 'cvexpert_course_ingest' || identity.login !== identity.effective || identity.elevated
        || identity.ddl || Number(identity.memberships) || Number(identity.owned)) throw new IngestError('LIMITED_INGEST_IDENTITY_REQUIRED');
    const unsafe = (await client.query(`SELECT EXISTS(
        SELECT 1 FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
        CROSS JOIN unnest(ARRAY['INSERT','UPDATE','DELETE','TRUNCATE','REFERENCES','TRIGGER']) p
        WHERE c.relkind IN ('r','p') AND n.nspname NOT IN ('pg_catalog','information_schema')
          AND n.nspname NOT LIKE 'pg_toast%' AND n.nspname NOT LIKE 'pg_temp%'
          AND (has_table_privilege(current_user,c.oid,p) OR c.relowner=(SELECT oid FROM pg_roles WHERE rolname=current_user)
            OR CASE WHEN p IN ('INSERT','UPDATE','REFERENCES') THEN has_any_column_privilege(current_user,c.oid,p) ELSE false END)
          AND NOT(n.nspname='public' AND c.relname IN ('courses','skills','course_skills') AND p='INSERT')
    ) AS unsafe`)).rows[0].unsafe;
    if (unsafe) throw new IngestError('INGEST_PRIVILEGES_TOO_BROAD');
    for (const table of ['courses','skills','course_skills']) {
        const access = (await client.query(`SELECT has_table_privilege(current_user,$1,'SELECT') AS readable,
            has_any_column_privilege(current_user,$1,'UPDATE') AS writable`,[`public.${table}`])).rows[0];
        if (!access.readable || access.writable) throw new IngestError('INGEST_PRIVILEGES_INVALID');
    }
    for (const [table,columns] of [['courses',['title','platform','url','is_paid','duration_hours','logo_url']],['skills',['name']],['course_skills',['course_id','skill_id']]] as const) {
        for (const column of columns) if (!(await client.query('SELECT has_column_privilege(current_user,$1,$2,\'INSERT\') AS allowed',
            [`public.${table}`,column])).rows[0].allowed) throw new IngestError('INGEST_INSERT_PERMISSION_REQUIRED');
    }
    for (const sequence of ['courses_id_seq','skills_id_seq']) if (!(await client.query(
        `SELECT has_sequence_privilege(current_user,$1,'USAGE') AND NOT has_sequence_privilege(current_user,$1,'UPDATE') AS allowed`,[`public.${sequence}`])).rows[0].allowed) throw new IngestError('INGEST_SEQUENCE_PERMISSION_INVALID');
}
export interface AppliedSource {
    provider: Discovery['provider']; found: number; inserted: number; existing: number; associations: number;
    rejected: Discovery['rejected']; sources: Discovery['sources'];
    courses: { title: string; url: string; skills: string[]; action: 'inserted' | 'existing'; evidence: AutomaticCourse['evidence'] }[];
}
export async function insertDiscoveredCourses(client: PoolClient, discovery: Discovery): Promise<AppliedSource> {
    // Separate transaction per provider: a failure never rolls back the other provider.
    await client.query('BEGIN ISOLATION LEVEL SERIALIZABLE');
    try {
        await client.query('SELECT pg_advisory_xact_lock(834921,1)'); // Cooperate with the existing catalog importer.
        const stored = (await client.query<{ id: number; name: string }>('SELECT id,name FROM public.skills')).rows;
        const report: AppliedSource = { provider: discovery.provider,found: discovery.found,inserted: 0,existing: 0,associations: 0,
            rejected: [...discovery.rejected],sources: discovery.sources,courses: [] };
        for (const c of discovery.courses) {
            if (!c.title || c.title !== c.title.trim() || c.title.length > 4096 || /[\p{Cc}\p{Cf}\p{Cs}]/u.test(c.title)
                || c.isPaid !== false || !c.url.startsWith('https://') || c.durationHours !== null
                    && (!Number.isSafeInteger(c.durationHours) || c.durationHours < 0 || c.durationHours > 2147483647)
                || c.platform !== (discovery.provider === 'openlearn' ? 'OpenLearn — The Open University' : 'freeCodeCamp')
                || !c.skills.length || c.skills.some(s => !vocabulary.includes(s)) || new Set(c.skills).size !== c.skills.length
                || !c.evidence.length || c.evidence.some(e => !/^[a-f0-9]{64}$/.test(e.sha256))) throw new IngestError('INVALID_COURSE_BATCH');
            officialCourseUrl(c.url,discovery.provider);
            // Never adopt an existing URL or add skills to an editorial/manual course, even if metadata differs.
            const urls = discovery.provider === 'openlearn' ? [c.url,c.url.replace(/^http:/,'https:'),c.url.replace(/^https:/,'http:')] : [c.url];
            if ((await client.query('SELECT id FROM public.courses WHERE url=ANY($1::text[]) OR (platform=$2 AND title=$3)',[urls,c.platform,c.title])).rowCount) {
                report.existing++; report.courses.push({ title: c.title,url: c.url,skills: c.skills,action: 'existing',evidence: c.evidence }); continue;
            }
            if (c.skills.some(name => {
                const matches = stored.filter(s => normalizeJobSkillName(s.name).key === normalizeJobSkillName(name).key);
                return matches.length > 1 || matches.length === 1 && matches[0]!.name !== name;
            })) { report.rejected.push({ url: c.url,reason: 'AMBIGUOUS_CANONICAL_SKILL' }); continue; }
            const inserted = await client.query<{ id: number }>(`INSERT INTO public.courses(title,platform,url,is_paid,duration_hours,logo_url)
                VALUES($1,$2,$3,$4,$5,NULL) ON CONFLICT(url) DO NOTHING RETURNING id`,[c.title,c.platform,c.url,c.isPaid,c.durationHours]);
            if (!inserted.rowCount) { report.existing++; report.courses.push({ title: c.title,url: c.url,skills: c.skills,action: 'existing',evidence: c.evidence }); continue; }
            for (const name of c.skills) {
                let skill = stored.find(s => s.name === name);
                if (!skill) {
                    await client.query('INSERT INTO public.skills(name) VALUES($1) ON CONFLICT(name) DO NOTHING',[name]);
                    skill = (await client.query<{ id: number; name: string }>('SELECT id,name FROM public.skills WHERE name=$1',[name])).rows[0]!;
                    stored.push(skill);
                }
                await client.query('INSERT INTO public.course_skills(course_id,skill_id) VALUES($1,$2)',[inserted.rows[0]!.id,skill.id]);
                report.associations++;
            }
            report.inserted++; report.courses.push({ title: c.title,url: c.url,skills: c.skills,action: 'inserted',evidence: c.evidence });
        }
        await client.query('COMMIT'); return report;
    } catch (e) { await client.query('ROLLBACK').catch(() => {}); throw e; }
}
