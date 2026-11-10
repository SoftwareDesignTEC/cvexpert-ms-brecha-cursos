import assert from 'node:assert/strict';
import { request } from 'node:http';
import { test } from 'node:test';
import { createApp } from '../src/app.js';
import { compareJobSkills } from '../src/domain/job-skills-gap.js';
import { InvalidAnalysisInput } from '../src/domain/skills-gap.js';
import { evaluateJobSkillsGap } from '../src/services/job-skills-gap.service.js';
import { headers, settings } from './helpers/authenticated-app.js';
import { withHttpApp } from './helpers/http.js';

const cv = { id: '00123', skills: [{ name: 'Python', level: 'advanced' }] };
const job = { id: 'offer:456', skills: ['Python'] };
const body = { cv, jobs: [job, { id: 'offer:789', skills: [] }] };

test('el dominio compara sin efectos secundarios y conserva el nivel declarado', () => {
    const skills = new Map([['python', 'advanced' as const]]);
    const requirements = [{ key: 'python', name: 'Python' }];
    const result = {
        status: 'complete', requiredSkillsCount: 1, documentedMatchesCount: 1, documentedCoveragePercent: 100,
        matchedSkills: [{ name: 'Python', cvLevel: 'advanced' }], notDocumentedSkills: [],
    };
    assert.deepEqual(compareJobSkills(skills, requirements), result);
    assert.deepEqual([...skills], [['python', 'advanced']]);
    assert.deepEqual(requirements, [{ key: 'python', name: 'Python' }]);
    assert.deepEqual(compareJobSkills(skills, requirements), result);
});

test('normaliza y deduplica nombres sin unir tecnologías distintas, con resultados en orden de entrada', () => {
    const input = {
        cv: { id: '00123', skills: [
            { name: 'Python', level: 'advanced' },
            { name: ' python ', level: 'advanced' },
            { name: ' SQL ', level: 'intermediate' },
            { name: 'GESTIO\u0301N   de\tdatos', level: 'beginner' },
            { name: 'Java', level: 'expert' },
            { name: 'C', level: 'beginner' },
            { name: 'Diseño', level: 'expert' },
        ] },
        jobs: [
            { id: 'offer:456', skills: [' python ', 'Docker', 'PYTHON', 'SQL', 'Gestión de datos', 'gestion de datos'] },
            { id: 'offer:789', skills: ['JavaScript', 'C++', 'Diseno', 'Java', 'C'] },
        ],
    };
    const expected = {
        cvId: '00123',
        dataSource: 'client_request',
        results: [
            {
                jobId: 'offer:456', status: 'partial', requiredSkillsCount: 4, documentedMatchesCount: 3,
                documentedCoveragePercent: 75,
                matchedSkills: [
                    { name: 'python', cvLevel: 'advanced' },
                    { name: 'SQL', cvLevel: 'intermediate' },
                    { name: 'Gestión de datos', cvLevel: 'beginner' },
                ],
                notDocumentedSkills: ['Docker'],
            },
            {
                jobId: 'offer:789', status: 'partial', requiredSkillsCount: 5, documentedMatchesCount: 2,
                documentedCoveragePercent: 40,
                matchedSkills: [{ name: 'Java', cvLevel: 'expert' }, { name: 'C', cvLevel: 'beginner' }],
                notDocumentedSkills: ['JavaScript', 'C++', 'Diseno'],
            },
        ],
    };
    assert.deepEqual(evaluateJobSkillsGap(input), expected);
    assert.deepEqual(evaluateJobSkillsGap(input), expected);
});

test('distingue un CV sin habilidades de ofertas sin requisitos identificables', () => {
    const evaluation = evaluateJobSkillsGap({
        cv: { ...cv, skills: [] },
        jobs: [job, { id: 'empty', skills: [] }, { id: 'blank', skills: ['', ' \t '] }],
    });
    assert.deepEqual(evaluation.results[0], {
        jobId: job.id, status: 'partial', requiredSkillsCount: 1, documentedMatchesCount: 0,
        documentedCoveragePercent: 0, matchedSkills: [], notDocumentedSkills: ['Python'],
    });
    for (const result of evaluation.results.slice(1)) {
        assert.deepEqual(result, {
            jobId: result.jobId, status: 'insufficient_information', requiredSkillsCount: 0, documentedMatchesCount: 0,
            documentedCoveragePercent: null, matchedSkills: [], notDocumentedSkills: [],
        });
    }
});

test('valida estructura, tamaños, IDs opacos y duplicados conflictivos', () => {
    const invalid = [
        null, [], {}, { cv, jobs: [] }, { cv, jobs: [job, job] }, { cv, jobs: Array(21).fill(job) },
        { ...body, userId: 'victim' }, { ...body, cv: { ...cv, email: 'ignored@example.org' } },
        { ...body, cv: { ...cv, id: 123 } }, { ...body, cv: { ...cv, id: ' ' } },
        { ...body, cv: { ...cv, id: 'x'.repeat(201) } },
        { ...body, cv: { ...cv, skills: Array(501).fill(cv.skills[0]) } },
        { ...body, cv: { ...cv, skills: [{ name: ' ', level: 'advanced' }] } },
        { ...body, cv: { ...cv, skills: [{ name: 'SQL', level: null }] } },
        { ...body, cv: { ...cv, skills: [{ name: 'SQL', level: 'novice' }] } },
        { ...body, cv: { ...cv, skills: [...cv.skills, { name: ' python ', level: 'beginner' }] } },
        { cv, jobs: [{ id: job.id }] }, { cv, jobs: [{ ...job, matchScore: 85 }] },
        { cv, jobs: [{ ...job, skills: [{ name: 'Python', level: 'expert' }] }] },
        { cv, jobs: [{ ...job, skills: ['\0'] }] }, { cv, jobs: [{ ...job, skills: ['x'.repeat(201)] }] },
        { cv, jobs: [{ ...job, skills: Array(201).fill('Python') }] },
    ];
    for (const value of invalid) assert.throws(() => evaluateJobSkillsGap(value), InvalidAnalysisInput);
    const result = evaluateJobSkillsGap({ cv: { ...cv, id: ' Cv:00123 ' }, jobs: [job, { ...job, id: 'OFFER:456' }] });
    assert.equal(result.cvId, ' Cv:00123 ');
    assert.deepEqual(result.results.map(item => item.jobId), ['offer:456', 'OFFER:456']);
});

const auth = { ...headers, 'X-User-Id': 'test-subject', 'Content-Type': 'application/json' };
const evaluate = (url: string, rawBody = JSON.stringify(body), requestHeaders: HeadersInit = auth, query = '') =>
    fetch(`${url}/skills-gap/evaluate${query}`, { method: 'POST', headers: requestHeaders, body: rawBody });

test('HTTP evalúa con certificado e identidad y sin mercado, instantánea o acceso a repositorios', async () => {
    const unexpected = () => assert.fail('La evaluación no debe consultar ni escribir en repositorios.');
    const app = createApp('test', { findPage: unexpected }, settings,
        { load: unexpected, replace: unexpected, async close() {} },
        { loadMarket: unexpected, async close() {} });
    await withHttpApp(app, async url => {
        const response = await evaluate(url);
        assert.equal(response.status, 200);
        assert.equal(response.headers.get('cache-control'), 'no-store');
        assert.deepEqual(await response.json(), evaluateJobSkillsGap(body));
    });
});

test('HTTP rechaza certificado, identidad ambigua, consulta y cuerpos inválidos con errores JSON sin datos de entrada', async () => {
    await withHttpApp(createApp('test', undefined, settings), async url => {
        const cases = [
            [403, 'APIM_CERTIFICATE_REQUIRED', '{', { ...auth, 'X-ARR-ClientCert': 'bad' }],
            [401, 'USER_IDENTITY_REQUIRED', '{', headers],
            [401, 'USER_IDENTITY_REQUIRED', JSON.stringify({ ...body, userId: 'victim' }), headers, '?userId=victim'],
            [401, 'USER_IDENTITY_REQUIRED', undefined, { ...auth, 'X-User-Id': 'a,b' }],
            [400, 'INVALID_QUERY', undefined, auth, '?userId=victim'],
            [400, 'INVALID_QUERY', undefined, auth, '?__proto__=ignored'],
            [400, 'INVALID_EVALUATION_INPUT', JSON.stringify({ ...body, userId: 'victim' })],
            [400, 'INVALID_JSON_BODY', '{'],
            [400, 'INVALID_JSON_BODY', undefined, { ...auth, 'Content-Type': 'application/json; charset=iso-8859-1' }],
            [413, 'INVALID_JSON_BODY', JSON.stringify({ ...body, padding: 'x'.repeat(102400) })],
        ] as const;
        for (const [status, error, rawBody, requestHeaders, query] of cases) {
            const response = await evaluate(url, rawBody, requestHeaders, query);
            assert.equal(response.status, status);
            assert.equal(response.headers.get('cache-control'), 'no-store');
            const content = await response.json() as { error: string; message: string };
            assert.equal(content.error, error);
            assert.doesNotMatch(content.message, /victim|Python/);
        }

        const duplicate = await new Promise<number | undefined>((resolve, reject) => {
            const req = request(`${url}/skills-gap/evaluate`, {
                method: 'POST', headers: { ...headers, 'X-User-Id': ['a', 'b'] },
            }, res => { res.resume(); resolve(res.statusCode); });
            req.on('error', reject);
            req.end();
        });
        assert.equal(duplicate, 401);
    });
});

test('HTTP el bypass local del catálogo no autoriza evaluaciones', async () => {
    await withHttpApp(createApp('test', undefined, { APIM_ALLOW_INSECURE_LOCAL: 'true' }), async url => {
        const response = await evaluate(url);
        assert.equal(response.status, 403);
        assert.equal(response.headers.get('cache-control'), 'no-store');
    });
});
