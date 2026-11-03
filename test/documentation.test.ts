import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { parse } from 'yaml';

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
    assert.deepEqual(Object.keys(specification.paths).sort(), ['/courses', '/health', '/skills-gap']);
    assert.deepEqual(specification.paths['/health'].get.security, []);
    assert.deepEqual(specification.security, [{ ApimCertificate: [] }]);
    assert.equal(specification.components.securitySchemes.ApimCertificate.name, 'X-ARR-ClientCert');
    for (const path of ['/courses', '/skills-gap']) {
        assert.deepEqual(Object.keys(specification.paths[path]), ['get']);
        for (const status of ['200', '400', '403', '503']) {
            assert.ok(specification.paths[path].get.responses[status].content['application/json'].schema);
        }
    }
});
