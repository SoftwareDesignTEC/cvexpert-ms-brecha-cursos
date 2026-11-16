-- Run only as disposable database owner, after 005. Never on a shared database.
DO $$
BEGIN
    IF current_database() !~ '^cvexpert_test_[a-f0-9]{32}$'
       OR inet_server_addr() IS NULL
       OR current_setting('server_version_num')::integer NOT BETWEEN 170000 AND 179999
       OR shobj_description((SELECT oid FROM pg_database WHERE datname=current_database()),'pg_database')
           IS DISTINCT FROM 'cvexpert-course-sync-disposable-v1'
       THEN RAISE EXCEPTION 'UNVERIFIED_DISPOSABLE_DATABASE'; END IF;
END $$;
GRANT USAGE ON SCHEMA course_sync TO cvexpert_sync_ingest, cvexpert_sync_editor;
GRANT EXECUTE ON FUNCTION course_sync.valid_document(jsonb) TO cvexpert_sync_ingest, cvexpert_sync_editor;
GRANT SELECT ON ALL TABLES IN SCHEMA course_sync TO cvexpert_sync_ingest, cvexpert_sync_editor;
GRANT INSERT(candidate_id,source_id,external_id,identity_key,canonical_url,title,observed,last_valid_seen_at)
    ON course_sync.candidates TO cvexpert_sync_ingest;
GRANT UPDATE(observed,title,canonical_url,last_valid_seen_at,missing_count)
    ON course_sync.candidates TO cvexpert_sync_ingest;
GRANT INSERT ON course_sync.runs,course_sync.observations,course_sync.checkpoints TO cvexpert_sync_ingest;
GRANT UPDATE(run_id,observed_at) ON course_sync.checkpoints TO cvexpert_sync_ingest;
GRANT INSERT,UPDATE ON course_sync.providers TO cvexpert_sync_editor;
GRANT UPDATE(verified,verified_by,verified_at,review_state,published_course_id,link_reviewed_by,link_reviewed_at)
    ON course_sync.candidates TO cvexpert_sync_editor;
-- No PUBLIC/HTTP grants, role membership, catalog grants or SECURITY DEFINER writer.
