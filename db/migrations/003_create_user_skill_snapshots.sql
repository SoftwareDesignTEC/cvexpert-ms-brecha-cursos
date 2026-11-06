-- Solo la instantánea vigente. No almacena correo, CV, token ni identificador original.
-- No concede permisos: el administrador debe autorizar el DML mínimo por separado.
CREATE TABLE public.user_skill_snapshots (
    subject_hash text PRIMARY KEY CHECK (subject_hash ~ '^[a-f0-9]{64}$'),
    adapter_key text NOT NULL CHECK (adapter_key = 'cv-skill-v1'),
    skills jsonb NOT NULL CHECK (jsonb_typeof(skills) = 'array' AND jsonb_array_length(skills) <= 500)
);
