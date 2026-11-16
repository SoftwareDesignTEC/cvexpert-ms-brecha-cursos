-- Isolated proposals: no ownership of, or DML on, the published catalog.
CREATE SCHEMA course_sync;
REVOKE ALL ON SCHEMA course_sync FROM PUBLIC;

CREATE TABLE course_sync.providers (
    source_id text PRIMARY KEY CHECK (source_id ~ '^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$'),
    authorization_state text NOT NULL DEFAULT 'pending' CHECK (authorization_state IN ('pending','authorized','revoked')),
    authorization_reference text,
    CHECK (authorization_state <> 'authorized' OR (authorization_reference IS NOT NULL AND length(btrim(authorization_reference)) > 0))
);

-- JSON carries the existing adapter vocabulary, not editorial approval. SQL enforces
-- shape/invariants; normalize() additionally validates URLs, dates and provenance.
CREATE FUNCTION course_sync.valid_document(d jsonb) RETURNS boolean
LANGUAGE plpgsql IMMUTABLE SET search_path = pg_catalog AS $$
DECLARE e jsonb; g jsonb;
BEGIN
    IF jsonb_typeof(d) IS DISTINCT FROM 'object'
       OR NOT d ?& ARRAY['sourceId','externalId','title','platform','canonicalUrl','associatedSkills',
           'language','durationMinutes','isPaid','validation','lastSeenAt','modality','geography','availability','offerings','evidence']
       OR jsonb_typeof(d->'associatedSkills') IS DISTINCT FROM 'array'
       OR jsonb_array_length(d->'associatedSkills') > 1000
       OR jsonb_typeof(d->'offerings') IS DISTINCT FROM 'array'
       OR jsonb_typeof(d->'evidence') IS DISTINCT FROM 'array'
       OR jsonb_array_length(d->'evidence') = 0 THEN RETURN false; END IF;
    FOREACH e IN ARRAY ARRAY[d->'sourceId',d->'title',d->'platform',d->'canonicalUrl',d->'lastSeenAt'] LOOP
        IF jsonb_typeof(e) IS DISTINCT FROM 'string' OR length(btrim(e #>> '{}')) = 0 THEN RETURN false; END IF;
    END LOOP;
    FOREACH e IN ARRAY ARRAY[d->'validation',d->'modality',d->'availability'] LOOP
        IF jsonb_typeof(e) IS DISTINCT FROM 'string' THEN RETURN false; END IF;
    END LOOP;
    IF d->>'canonicalUrl' !~ '^https://[^[:space:]#@]+$'
       OR d->>'validation' NOT IN ('needs_review','conflict')
       OR d->>'modality' NOT IN ('virtual','presential','hybrid','unknown')
       OR d->>'availability' NOT IN ('available','unavailable','withdrawn','unknown')
       OR jsonb_typeof(d->'externalId') NOT IN ('string','null')
       OR jsonb_typeof(d->'language') NOT IN ('string','null')
       OR jsonb_typeof(d->'isPaid') NOT IN ('boolean','null')
       OR jsonb_typeof(d->'geography') NOT IN ('object','null')
       OR (d->'durationMinutes' <> 'null'::jsonb AND
          (jsonb_typeof(d->'durationMinutes') <> 'number' OR (d->>'durationMinutes')::numeric <= 0
           OR (d->>'durationMinutes')::numeric <> trunc((d->>'durationMinutes')::numeric))) THEN RETURN false; END IF;
    PERFORM (d->>'lastSeenAt')::timestamptz;
    IF d ? 'price' AND d->'price' <> 'null'::jsonb THEN
        IF jsonb_typeof(d->'price') IS DISTINCT FROM 'object'
           OR NOT (d->'price') ?& ARRAY['amount','currency']
           OR (SELECT count(*) FROM jsonb_object_keys(d->'price')) <> 2
           OR jsonb_typeof(d->'price'->'amount') IS DISTINCT FROM 'string'
           OR jsonb_typeof(d->'price'->'currency') IS DISTINCT FROM 'string'
           OR d->'price'->>'amount' !~ '^(0|[1-9][0-9]{0,11})(\.[0-9]{1,4})?$'
           OR d->'price'->>'currency' !~ '^[A-Z]{3}$' THEN RETURN false; END IF;
    END IF;
    g := d->'geography';
    IF g <> 'null'::jsonb THEN
        IF NOT g ?& ARRAY['country','region','locality'] THEN RETURN false; END IF;
        FOR e IN SELECT value FROM jsonb_each(g) LOOP
            IF jsonb_typeof(e) NOT IN ('string','null') THEN RETURN false; END IF;
        END LOOP;
    END IF;
    FOR e IN SELECT value FROM jsonb_array_elements(d->'associatedSkills') LOOP
        IF jsonb_typeof(e) <> 'string' OR length(btrim(e #>> '{}')) = 0 THEN RETURN false; END IF;
    END LOOP;
    FOR e IN SELECT value FROM jsonb_array_elements(d->'evidence') LOOP
        IF jsonb_typeof(e) IS DISTINCT FROM 'object'
           OR NOT e ?& ARRAY['apiUrl','returnedUrl','title','queriedAt','responseSha256']
           OR e->>'responseSha256' !~ '^[a-f0-9]{64}$'
           OR e->>'apiUrl' !~ '^https://[^[:space:]#@]+$'
           OR e->>'returnedUrl' !~ '^https://[^[:space:]#@]+$'
           OR e->>'queriedAt' IS DISTINCT FROM d->>'lastSeenAt'
           OR jsonb_typeof(e->'responseSha256') IS DISTINCT FROM 'string'
           OR jsonb_typeof(e->'apiUrl') IS DISTINCT FROM 'string'
           OR jsonb_typeof(e->'returnedUrl') IS DISTINCT FROM 'string'
           OR jsonb_typeof(e->'title') IS DISTINCT FROM 'string' THEN RETURN false; END IF;
    END LOOP;
    FOR e IN SELECT value FROM jsonb_array_elements(d->'offerings') LOOP
        IF jsonb_typeof(e) IS DISTINCT FROM 'object'
           OR NOT e ?& ARRAY['externalId','availability','startsAt','endsAt','modality','geography']
           OR length(btrim(e->>'externalId')) = 0
           OR e->>'availability' NOT IN ('available','unavailable','withdrawn','unknown')
           OR e->>'modality' NOT IN ('virtual','presential','hybrid','unknown')
           OR jsonb_typeof(e->'externalId') IS DISTINCT FROM 'string'
           OR jsonb_typeof(e->'availability') IS DISTINCT FROM 'string'
           OR jsonb_typeof(e->'modality') IS DISTINCT FROM 'string'
           OR jsonb_typeof(e->'startsAt') NOT IN ('string','null')
           OR jsonb_typeof(e->'endsAt') NOT IN ('string','null')
           OR jsonb_typeof(e->'geography') NOT IN ('object','null') THEN RETURN false; END IF;
        g := e->'geography';
        IF g <> 'null'::jsonb AND (NOT g ?& ARRAY['country','region','locality']
            OR EXISTS (SELECT 1 FROM jsonb_each(g) p WHERE jsonb_typeof(p.value) NOT IN ('string','null'))) THEN RETURN false; END IF;
        IF (e->>'startsAt')::timestamptz > (e->>'endsAt')::timestamptz THEN RETURN false; END IF;
    END LOOP;
    IF (SELECT count(*) FROM jsonb_array_elements(d->'offerings')) <>
       (SELECT count(DISTINCT v->>'externalId') FROM jsonb_array_elements(d->'offerings') v) THEN RETURN false; END IF;
    RETURN true;
EXCEPTION WHEN OTHERS THEN RETURN false;
END $$;

CREATE TABLE course_sync.candidates (
    candidate_id uuid PRIMARY KEY,
    source_id text NOT NULL REFERENCES course_sync.providers(source_id),
    external_id text CHECK (external_id = btrim(external_id) AND external_id <> '' AND length(external_id) <= 512),
    identity_key text NOT NULL,
    canonical_url text NOT NULL UNIQUE CHECK (canonical_url ~ '^https://[^[:space:]#@]+$' AND length(canonical_url) <= 2000),
    title text NOT NULL CHECK (title = btrim(title) AND title <> ''),
    origin text NOT NULL DEFAULT 'sync' CHECK (origin IN ('sync','manual')),
    observed jsonb NOT NULL CHECK (course_sync.valid_document(observed)),
    verified jsonb CHECK (verified IS NULL OR course_sync.valid_document(verified)),
    verified_by text,
    verified_at timestamptz,
    review_state text NOT NULL DEFAULT 'pending' CHECK (review_state IN ('pending','verified','rejected','conflict')),
    published_course_id integer REFERENCES public.courses(id) ON DELETE RESTRICT,
    link_reviewed_by text,
    link_reviewed_at timestamptz,
    last_valid_seen_at timestamptz NOT NULL,
    missing_count integer NOT NULL DEFAULT 0 CHECK (missing_count BETWEEN 0 AND 3),
    version integer NOT NULL DEFAULT 1 CHECK (version > 0),
    UNIQUE (source_id, identity_key),
    CHECK (source_id = observed->>'sourceId' AND external_id IS NOT DISTINCT FROM observed->>'externalId'
        AND canonical_url = observed->>'canonicalUrl' AND title = observed->>'title'),
    CHECK (last_valid_seen_at = (observed->>'lastSeenAt')::timestamptz),
    CHECK (verified IS NULL OR (source_id = verified->>'sourceId' AND external_id IS NOT DISTINCT FROM verified->>'externalId')),
    CHECK (identity_key = jsonb_build_array(source_id, CASE WHEN external_id IS NULL THEN 'url' ELSE 'id' END,
        COALESCE(external_id, canonical_url))::text),
    CHECK ((verified IS NULL AND verified_by IS NULL AND verified_at IS NULL) OR
        (verified IS NOT NULL AND verified_by IS NOT NULL AND length(btrim(verified_by)) > 0 AND verified_at IS NOT NULL)),
    CHECK (review_state <> 'verified' OR verified IS NOT NULL),
    CHECK ((published_course_id IS NULL AND link_reviewed_by IS NULL AND link_reviewed_at IS NULL) OR
        (published_course_id IS NOT NULL AND link_reviewed_by IS NOT NULL AND length(btrim(link_reviewed_by)) > 0 AND link_reviewed_at IS NOT NULL))
);
CREATE INDEX candidates_review_idx ON course_sync.candidates(source_id, review_state);
CREATE INDEX candidates_published_idx ON course_sync.candidates(published_course_id) WHERE published_course_id IS NOT NULL;

CREATE FUNCTION course_sync.version_candidate() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog AS $$
BEGIN
    IF OLD.origin = 'manual' AND (NEW.observed IS DISTINCT FROM OLD.observed
        OR NEW.missing_count <> OLD.missing_count OR NEW.last_valid_seen_at <> OLD.last_valid_seen_at) THEN
        RAISE EXCEPTION 'MANUAL_PROTECTED';
    END IF;
    IF NEW.source_id <> OLD.source_id OR NEW.external_id IS DISTINCT FROM OLD.external_id
        OR NEW.origin <> OLD.origin THEN RAISE EXCEPTION 'IMMUTABLE_IDENTITY'; END IF;
    NEW.version := OLD.version + 1;
    RETURN NEW;
END $$;
CREATE TRIGGER candidate_version BEFORE UPDATE ON course_sync.candidates
FOR EACH ROW EXECUTE FUNCTION course_sync.version_candidate();

CREATE TABLE course_sync.runs (
    source_id text NOT NULL REFERENCES course_sync.providers(source_id),
    run_id text NOT NULL CHECK (length(btrim(run_id)) > 0),
    input_sha256 text NOT NULL CHECK (input_sha256 ~ '^[a-f0-9]{64}$'),
    observed_at timestamptz NOT NULL,
    scope text NOT NULL CHECK (scope IN ('full_catalog','query')),
    status text NOT NULL CHECK (status IN ('complete','partial','failed')),
    coverage jsonb NOT NULL CHECK (jsonb_typeof(coverage) = 'object'
        AND coverage ?& ARRAY['valid','missingPages','quotaLimited','errors']
        AND jsonb_typeof(coverage->'valid') = 'boolean' AND jsonb_typeof(coverage->'missingPages') = 'boolean'
        AND jsonb_typeof(coverage->'quotaLimited') = 'boolean' AND jsonb_typeof(coverage->'errors') = 'array'),
    result jsonb NOT NULL CHECK (jsonb_typeof(result) = 'object'),
    recorded_at timestamptz NOT NULL DEFAULT clock_timestamp(),
    PRIMARY KEY(source_id, run_id),
    UNIQUE(source_id, run_id, observed_at)
);
CREATE INDEX runs_time_idx ON course_sync.runs(source_id, observed_at DESC);
CREATE TABLE course_sync.observations (
    source_id text NOT NULL,
    run_id text NOT NULL,
    ordinal integer NOT NULL CHECK (ordinal >= 0),
    identity_key text NOT NULL,
    document jsonb NOT NULL CHECK (course_sync.valid_document(document)),
    PRIMARY KEY(source_id, run_id, ordinal),
    FOREIGN KEY(source_id, run_id) REFERENCES course_sync.runs(source_id, run_id),
    CHECK (source_id = document->>'sourceId'),
    CHECK (identity_key = jsonb_build_array(source_id, CASE WHEN document->>'externalId' IS NULL THEN 'url' ELSE 'id' END,
        COALESCE(document->>'externalId',document->>'canonicalUrl'))::text)
);
CREATE INDEX observations_identity_idx ON course_sync.observations(source_id, identity_key);
CREATE TABLE course_sync.checkpoints (
    source_id text PRIMARY KEY,
    run_id text NOT NULL,
    observed_at timestamptz NOT NULL,
    FOREIGN KEY(source_id, run_id, observed_at) REFERENCES course_sync.runs(source_id, run_id, observed_at)
);
-- No role receives grants through a migration. Explicit local provisioning only.
REVOKE ALL ON ALL TABLES IN SCHEMA course_sync FROM PUBLIC;
REVOKE ALL ON ALL FUNCTIONS IN SCHEMA course_sync FROM PUBLIC;
