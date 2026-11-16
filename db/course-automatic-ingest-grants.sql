-- Explicit DBA/owner action, never run by HTTP/ingestion. Provision the dedicated
-- LOGIN separately, with its own secret. This script cannot change existing grants.
-- SET cvexpert.course_ingest_grants_database = '<explicit target database>' first.
BEGIN;
DO $$
DECLARE r record;
BEGIN
    IF current_setting('cvexpert.course_ingest_grants_database',true) IS DISTINCT FROM current_database()
        THEN RAISE EXCEPTION 'EXPLICIT_DATABASE_CONFIRMATION_REQUIRED'; END IF;
    SELECT * INTO r FROM pg_roles WHERE rolname='cvexpert_course_ingest';
    IF r.oid IS NULL OR NOT r.rolcanlogin OR r.rolsuper OR r.rolcreatedb OR r.rolcreaterole
        OR r.rolbypassrls OR r.rolreplication OR r.rolinherit
        OR EXISTS(SELECT 1 FROM pg_auth_members WHERE member=r.oid)
        THEN RAISE EXCEPTION 'LIMITED_SEPARATE_LOGIN_REQUIRED'; END IF;
END $$;
GRANT USAGE ON SCHEMA public TO cvexpert_course_ingest;
GRANT SELECT ON public.courses,public.skills,public.course_skills TO cvexpert_course_ingest;
GRANT INSERT(title,platform,url,is_paid,duration_hours,logo_url) ON public.courses TO cvexpert_course_ingest;
GRANT INSERT(name) ON public.skills TO cvexpert_course_ingest;
GRANT INSERT(course_id,skill_id) ON public.course_skills TO cvexpert_course_ingest;
GRANT USAGE ON SEQUENCE public.courses_id_seq,public.skills_id_seq TO cvexpert_course_ingest;
COMMIT;
