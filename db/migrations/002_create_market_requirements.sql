-- Copia mantenida por Brecha/Cursos. No importa datos ni concede escrituras al rol HTTP.
CREATE TABLE public.market_requirements (
    market_key text NOT NULL,
    skill_id integer NOT NULL REFERENCES public.skills(id) ON DELETE RESTRICT,
    scale_key text,
    required_level integer,
    source_reference text NOT NULL,
    observed_at timestamptz NOT NULL,
    data_kind text NOT NULL CHECK (data_kind IN ('reference', 'demo')),
    PRIMARY KEY (market_key, skill_id),
    CHECK (market_key = btrim(market_key) AND market_key <> ''),
    CHECK (scale_key = btrim(scale_key) AND scale_key <> ''),
    CHECK (source_reference = btrim(source_reference) AND source_reference <> '')
);

-- La PK cubre consultas por contexto; este índice cubre la FK al eliminar habilidades.
CREATE INDEX market_requirements_skill_idx ON public.market_requirements (skill_id);
