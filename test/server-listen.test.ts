import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { X509Certificate } from 'node:crypto';
import { once } from 'node:events';
import { readFileSync } from 'node:fs';
import type { AddressInfo } from 'node:net';
import { networkInterfaces } from 'node:os';
import { test } from 'node:test';

// Importa el punto de entrada real en otro proceso: ejecuta app.listen y devuelve
// server.address(), sin simular sockets ni heredar el .env local.
const bootstrap = `
    import { once } from 'node:events';
    const { server } = await import('./src/server.ts');
    if (!server.listening) await once(server, 'listening');
    process.send(server.address());
`;
const certificate = new X509Certificate(readFileSync(new URL('./fixtures/certificates/valid.pem', import.meta.url)));

for (const scenario of [
    { name: 'development con bypass', environment: 'development', bypass: 'true', host: '127.0.0.1', status: 200 },
    { name: 'test con bypass', environment: 'test', bypass: 'true', host: '127.0.0.1', status: 200 },
    { name: 'development sin bypass', environment: 'development', host: '0.0.0.0', status: 503 },
    { name: 'production rechaza bypass', environment: 'production', bypass: 'true', host: '0.0.0.0', status: 503 },
    { name: 'production exige certificado aunque se pida bypass', environment: 'production', bypass: 'true', configured: true, host: '0.0.0.0', status: 403 },
    { name: 'Azure ignora bypass local', environment: 'development', bypass: 'true', azure: true, host: '0.0.0.0', status: 503 },
]) {
    test(`escucha real: ${scenario.name}`, { timeout: 15000 }, async () => {
        const env = { ...process.env };
        for (const key of Object.keys(env)) {
            if (key.startsWith('WEBSITE_') || key.startsWith('APIM_')) delete env[key];
        }
        Object.assign(env, { NODE_ENV: scenario.environment, PORT: '0', HOST: '0.0.0.0',
            DOTENV_CONFIG_PATH: '.no-env-for-server-listen-test', DOTENV_CONFIG_QUIET: 'true' });
        if (scenario.bypass) env.APIM_ALLOW_INSECURE_LOCAL = scenario.bypass;
        if (scenario.azure) env.WEBSITE_SITE_NAME = 'test-app-service';
        if (scenario.configured) env.APIM_CERT_THUMBPRINTS = certificate.fingerprint.replaceAll(':', '');
        const child = spawn(process.execPath, ['--import', 'tsx', '--input-type=module', '--eval', bootstrap], {
            cwd: new URL('../', import.meta.url), env, stdio: ['ignore', 'ignore', 'pipe', 'ipc'],
        });
        const closed = once(child, 'exit');
        let errors = '';
        child.stderr!.on('data', chunk => { errors += chunk; });
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), 10000);
        try {
            const [address] = await once(child, 'message', { signal: controller.signal }) as [AddressInfo];
            assert.equal(address.address, scenario.host, errors);
            assert.equal(address.family, 'IPv4');
            const response = await fetch(`http://127.0.0.1:${address.port}/skills-gap`);
            assert.equal(response.status, scenario.status);
            if (scenario.status === 503) {
                assert.equal((await response.json() as { error: string }).error, 'APIM_SECURITY_UNAVAILABLE');
            } else if (scenario.status === 403) {
                assert.equal((await response.json() as { error: string }).error, 'APIM_CERTIFICATE_REQUIRED');
                const authenticated = await fetch(`http://127.0.0.1:${address.port}/skills-gap`, {
                    headers: { 'X-ARR-ClientCert': certificate.raw.toString('base64') },
                });
                assert.equal(authenticated.status, 503);
                assert.equal((await authenticated.json() as { error: string }).error, 'SKILLS_GAP_UNAVAILABLE');
            } else {
                assert.equal(response.headers.get('x-data-mode'), 'demo');
                const external = Object.values(networkInterfaces()).flat().find(entry =>
                    entry?.family === 'IPv4' && !entry.internal);
                if (external) {
                    await assert.rejects(fetch(`http://${external.address}:${address.port}/skills-gap`, {
                        signal: AbortSignal.timeout(1000),
                    }), 'El puerto con bypass no debe aceptar conexiones por la interfaz de red');
                }
            }
            assert.equal((await fetch(`http://127.0.0.1:${address.port}/health`)).status, 200);
        } finally {
            clearTimeout(timer);
            child.kill();
            await closed;
        }
    });
}
