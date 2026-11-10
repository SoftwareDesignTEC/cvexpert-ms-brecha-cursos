import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { parse } from 'yaml';
import { evaluateJobSkillsGap } from '../src/services/job-skills-gap.service.js';

test('contrato activo: referencias resolubles, seguridad y solo operaciones implementadas', () => {
    const specification = parse(readFileSync(new URL('../openapi.yaml', import.meta.url), 'utf8'));
    const visit = (value: unknown) => {
        if (!value || typeof value !== 'object') return;
        for (const [key, child] of Object.entries(value)) {
            if (key === '$ref') {
                assert.equal(typeof child, 'string');
                const segments = String(child).split('/');
                assert.equal(segments.shift(), '#');
                assert.ok(segments.reduce((node, segment) => node?.[segment], specification), String(child));
            } else visit(child);
        }
    };
    visit(specification);
    assert.deepEqual(Object.keys(specification.paths).sort(),
        ['/courses', '/health', '/skills-gap', '/skills-gap/evaluate', '/skills-gap/input', '/skills-gap/recommendations']);
    assert.deepEqual(specification.paths['/health'].get.security, []);
    assert.equal(specification.security, undefined);
    assert.equal(specification.components.securitySchemes, undefined);
    const transport = specification['x-backend-authentication'];
    assert.equal(transport.type, 'mutualTLS');
    assert.equal(transport.boundary, 'apim-to-app-service');
    assert.equal(transport.certificateForwarding.header, 'X-ARR-ClientCert');
    assert.equal(transport.certificateForwarding.consumerSupplied, false);
    assert.deepEqual(transport.excludedPaths, ['/health']);
    const identity = specification['x-apim-user-authentication'];
    assert.equal(identity.boundary, 'consumer-to-apim');
    assert.match(identity.description, /backend no verifica tokens Google ni otros JWT/);
    assert.match(specification.info.description, /no debe introducirlo manualmente/);
    for (const path of ['/courses', '/skills-gap']) {
        assert.deepEqual(Object.keys(specification.paths[path]), ['get']);
        assert.equal(specification.paths[path].get.security, undefined);
        for (const parameter of specification.paths[path].get.parameters ?? []) {
            assert.notEqual(parameter.name.toLowerCase(), 'x-arr-clientcert');
        }
        for (const status of ['200', '400', '403', '503']) {
            assert.ok(specification.paths[path].get.responses[status].content['application/json'].schema);
        }
    }
    const evaluate = specification.paths['/skills-gap/evaluate'].post;
    assert.deepEqual(Object.keys(evaluate.responses).sort(), ['200', '400', '401', '403', '413', '503']);
    assert.deepEqual(evaluateJobSkillsGap(evaluate.requestBody.content['application/json'].example),
        evaluate.responses['200'].content['application/json'].example);
    const recommendations = specification.paths['/skills-gap/recommendations'].post;
    assert.deepEqual(recommendations.requestBody.content['application/json'].schema,
        evaluate.requestBody.content['application/json'].schema);
    assert.deepEqual(Object.keys(recommendations.responses).sort(), ['200', '400', '401', '403', '413', '503']);
    assert.equal(specification.components.schemas.SkillCourseRecommendation.properties.courses.maxItems, 5);
});
