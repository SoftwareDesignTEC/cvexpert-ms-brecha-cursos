CREATE TABLE public.skills (
    id integer GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    name text NOT NULL UNIQUE,
    CONSTRAINT skills_name_not_blank CHECK (name = btrim(name) AND name <> '')
);

CREATE TABLE public.courses (
    id integer GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    title text NOT NULL,
    platform text NOT NULL,
    url text NOT NULL UNIQUE,
    is_paid boolean NOT NULL,
    duration_hours integer,
    logo_url text,
    CONSTRAINT courses_title_not_blank CHECK (title = btrim(title) AND title <> ''),
    CONSTRAINT courses_platform_not_blank CHECK (platform = btrim(platform) AND platform <> ''),
    CONSTRAINT courses_url_http CHECK (url ~ '^https?://[^[:space:]]+$'),
    CONSTRAINT courses_duration_nonnegative CHECK (duration_hours >= 0),
    CONSTRAINT courses_logo_url_http CHECK (logo_url ~ '^https?://[^[:space:]]+$')
);

CREATE TABLE public.course_skills (
    course_id integer NOT NULL REFERENCES public.courses(id) ON DELETE CASCADE,
    skill_id integer NOT NULL REFERENCES public.skills(id) ON DELETE RESTRICT,
    PRIMARY KEY (course_id, skill_id)
);

-- La PK cubre búsquedas por curso. Este índice cubre la dirección inversa.
CREATE INDEX course_skills_skill_course_idx ON public.course_skills (skill_id, course_id);
