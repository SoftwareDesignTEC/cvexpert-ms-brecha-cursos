import assert from 'node:assert/strict';
import { X509Certificate } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { createApp } from '../src/app.js';
import { withHttpApp } from './helpers/http.js';

const certificates = Object.fromEntries(['valid', 'rotated', 'expired', 'future'].map(name =>
    [name, new X509Certificate(readFileSync(new URL(`./fixtures/certificates/${name}.pem`, import.meta.url)))]));
const thumbprint = (name: string) => certificates[name].fingerprint.replaceAll(':', '');
const header = (name: string) => ({ 'X-ARR-ClientCert': certificates[name].raw.toString('base64') });
const repository = { async findPage() { return { items: [], totalRecords: 0 }; } };
const settings = { APIM_CERT_THUMBPRINTS: thumbprint('valid') };

test('certificado X.509 correcto conserva courses, demo y documentación protegida', async () => {
    await withHttpApp(createApp('test', repository, settings), async url => {
        const init = { headers: header('valid') };
        const courses = await fetch(`${url}/courses`, init);
        assert.equal(courses.status, 200);
        assert.deepEqual(await courses.json(), { items: [], page: 1, pageSize: 20, totalRecords: 0 });
        const demo = await fetch(`${url}/skills-gap`, init);
        assert.equal(demo.status, 200);
        assert.equal(demo.headers.get('x-data-mode'), 'demo');
        assert.equal((await demo.json() as { totalRecords: number }).totalRecords, 3);
        for (const path of ['/docs', '/docs/', '/docs/swagger-ui.css', '/docs/swagger-ui-bundle.js', '/docs/init.js', '/openapi.yaml', '/openapi.json']) {
            const response = await fetch(`${url}${path}`, init);
            assert.equal(response.status, 200, path);
            assert.ok((await response.text()).length > 20, path);
        }
        const specification = await (await fetch(`${url}/openapi.json`, init)).json() as { paths: Record<string, unknown> };
        assert.deepEqual(Object.keys(specification.paths).sort(), ['/courses', '/health', '/skills-gap']);
    });
});

test('rechaza certificados incorrectos, vencidos, futuros, ausentes y Base64/X.509 malformados', async () => {
    await withHttpApp(createApp('test', repository, settings), async url => {
        const valid = header('valid')['X-ARR-ClientCert'];
        for (const value of [undefined, header('rotated')['X-ARR-ClientCert'], '', '!!', 'YWJj', `${valid},${valid}`,
            `${valid}\n`, valid.replace(/=+$/, ''), Buffer.concat([certificates.valid.raw, Buffer.from('junk')]).toString('base64')]) {
            // Un certificado DER sin padding podría ser canónico; no usar ese caso si es idéntico.
            if (value === valid) continue;
            const headers: Record<string, string> = { 'X-User-Id': 'admin', 'X-User-Email': 'fake@example.org' };
            // fetch recorta espacios finales; usar espacios internos para comprobar rechazo estricto.
            if (value !== undefined) headers['X-ARR-ClientCert'] = value.endsWith('\n') ? `${valid.slice(0, 8)} ${valid.slice(8)}` : value;
            for (const path of ['/courses', '/skills-gap', '/docs/', '/openapi.json', '/openapi.yaml', '/docs/swagger-ui.css']) {
                const response = await fetch(`${url}${path}`, { headers });
                assert.equal(response.status, 403, path);
                assert.equal((await response.json() as { error: string }).error, 'APIM_CERTIFICATE_REQUIRED');
            }
        }
    });
    for (const name of ['expired', 'future']) {
        await withHttpApp(createApp('test', repository, { APIM_CERT_THUMBPRINTS: thumbprint(name) }), async url => {
            assert.equal((await fetch(`${url}/courses`, { headers: header(name) })).status, 403);
        });
    }
});

test('rotación acepta ambas huellas y producción mantiene skills-gap en 503', async () => {
    await withHttpApp(createApp('production', repository, {
        APIM_CERT_THUMBPRINTS: ` ${thumbprint('valid').toLowerCase()}, ${thumbprint('rotated')} `,
    }), async url => {
        for (const name of ['valid', 'rotated']) {
            const init = { headers: header(name) };
            assert.equal((await fetch(`${url}/courses`, init)).status, 200);
            const gaps = await fetch(`${url}/skills-gap`, init);
            assert.equal(gaps.status, 503);
            assert.equal((await gaps.json() as { error: string }).error, 'SKILLS_GAP_UNAVAILABLE');
        }
    });
});

test('configuración ausente o inválida cierra negocio y docs; health permanece independiente', async () => {
    for (const value of [undefined, '', 'bad', `${thumbprint('valid')},`, `${thumbprint('valid')},bad`]) {
        await withHttpApp(createApp('production', repository, { APIM_CERT_THUMBPRINTS: value, APIM_ALLOW_INSECURE_LOCAL: 'true' }), async url => {
            for (const path of ['/courses', '/skills-gap', '/docs/', '/openapi.yaml']) {
                assert.equal((await fetch(`${url}${path}`, { headers: header('valid') })).status, 503);
            }
            const health = await fetch(`${url}/health`);
            assert.equal(health.status, 200);
            assert.deepEqual(await health.json(), { status: 'ok', service: 'brecha-cursos' });
        });
    }
});

test('bypass requiere opción explícita, entorno local y ausencia de Azure', async () => {
    for (const environment of ['development', 'test', 'production', 'staging', undefined]) {
        for (const azure of [false, true]) {
            for (const bypass of [undefined, 'true', 'false', 'TRUE']) {
                await withHttpApp(createApp(environment, repository, {
                    ...(azure ? { WEBSITE_INSTANCE_ID: 'test-azure' } : {}), APIM_ALLOW_INSECURE_LOCAL: bypass,
                }), async url => {
                    const expected = !azure && ['development', 'test'].includes(environment ?? '') && bypass === 'true' ? 200 : 503;
                    assert.equal((await fetch(`${url}/courses`)).status, expected);
                });
            }
        }
    }
    await withHttpApp(createApp('development', repository, {
        ...settings, WEBSITE_SITE_NAME: 'cvexpert-ms-brecha-cursos', APIM_ALLOW_INSECURE_LOCAL: 'true',
    }), async url => {
        assert.equal((await fetch(`${url}/courses`)).status, 403);
        assert.equal((await fetch(`${url}/courses`, { headers: header('valid') })).status, 200);
    });
});
