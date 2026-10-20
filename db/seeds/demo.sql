-- Solo ejemplos ficticios; no son cursos ni recomendaciones auténticas.
INSERT INTO public.skills (name)
VALUES ('[DEMO] SQL'), ('[DEMO] TypeScript')
ON CONFLICT (name) DO NOTHING;

INSERT INTO public.courses (title, platform, url, is_paid, duration_hours, logo_url)
VALUES
    ('[DEMO] Curso ficticio de SQL', '[DEMO] Plataforma ficticia',
     'https://example.org/cvexpert-demo/sql', false, 8, NULL),
    ('[DEMO] Curso ficticio de backend', '[DEMO] Plataforma ficticia',
     'https://example.org/cvexpert-demo/backend', true, NULL, NULL)
ON CONFLICT (url) DO NOTHING;

INSERT INTO public.course_skills (course_id, skill_id)
SELECT c.id, s.id
FROM (VALUES
    ('https://example.org/cvexpert-demo/sql', '[DEMO] SQL'),
    ('https://example.org/cvexpert-demo/backend', '[DEMO] SQL'),
    ('https://example.org/cvexpert-demo/backend', '[DEMO] TypeScript')
) AS demo(course_url, skill_name)
JOIN public.courses c ON c.url = demo.course_url
JOIN public.skills s ON s.name = demo.skill_name
ON CONFLICT (course_id, skill_id) DO NOTHING;
