-- Evidencia atómica: una fila existe únicamente si el lote confirmó COMMIT.
-- Sin grants: las identidades administrativas se autorizan por separado.
CREATE TABLE public.admin_import_runs (
    execution_id uuid PRIMARY KEY,
    approval_sha256 text NOT NULL CHECK (approval_sha256 ~ '^[a-f0-9]{64}$'),
    batch_sha256 text NOT NULL CHECK (batch_sha256 ~ '^[a-f0-9]{64}$'),
    target jsonb NOT NULL,
    approval jsonb NOT NULL,
    input_document jsonb NOT NULL,
    verification jsonb NOT NULL,
    applied_by text NOT NULL DEFAULT session_user,
    recorded_at timestamptz NOT NULL DEFAULT clock_timestamp()
);

-- Permite bloquear sin conceder UPDATE/DELETE sobre el catálogo al importador.
CREATE FUNCTION public.lock_admin_import_tables() RETURNS void
LANGUAGE sql SECURITY DEFINER SET search_path = pg_catalog
AS $$
    LOCK TABLE public.skills, public.courses, public.course_skills,
        public.market_requirements, public.admin_import_runs IN SHARE ROW EXCLUSIVE MODE;
$$;
REVOKE ALL ON FUNCTION public.lock_admin_import_tables() FROM PUBLIC;
