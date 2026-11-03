import { readFileSync } from 'node:fs';
import { X509Certificate } from 'node:crypto';
import { createApp as application } from '../../src/app.js';

// Certificado público de prueba; su clave privada se descartó al generarlo.
const certificate = new X509Certificate(readFileSync(new URL('../fixtures/certificates/valid.pem', import.meta.url)));
export const headers = { 'X-ARR-ClientCert': certificate.raw.toString('base64') };
export const settings = { APIM_CERT_THUMBPRINTS: certificate.fingerprint.replaceAll(':', '') };
export const createApp: typeof application = (environment, repository) => application(environment, repository, settings);
export const fetch: typeof globalThis.fetch = (input, init) => globalThis.fetch(input, {
    ...init, headers: { ...headers, ...init?.headers },
});
