import { X509Certificate } from 'node:crypto';
import type { RequestHandler } from 'express';

export function isLocalCertificateBypass(environment: string | undefined, settings: NodeJS.ProcessEnv): boolean {
    const azure = Object.keys(settings).some(key => key.startsWith('WEBSITE_'));
    return !azure && (environment === 'development' || environment === 'test')
        && settings.APIM_ALLOW_INSECURE_LOCAL === 'true';
}

// Azure termina TLS e inyecta este encabezado. Fuera de esa frontera confiable,
// el certificado público por sí solo no demuestra posesión de su clave privada.
export function createApimCertificateGuard(environment: string | undefined, settings: NodeJS.ProcessEnv): RequestHandler {
    const local = isLocalCertificateBypass(environment, settings);
    const entries = (settings.APIM_CERT_THUMBPRINTS ?? '').split(',').map(value => value.trim().toUpperCase());
    const configured = entries.every(value => /^[A-F0-9]{40}$/.test(value));
    const allowed = new Set(entries);

    return (req, res, next) => {
        if (local) return next();
        res.set('Cache-Control', 'no-store');
        if (!configured) {
            res.status(503).json({ error: 'APIM_SECURITY_UNAVAILABLE', message: 'Seguridad del backend no configurada.' });
            return;
        }
        try {
            const header = req.headers['x-arr-clientcert'];
            // Base64 DER canónico, sin PEM, espacios, valores múltiples ni basura.
            if (typeof header !== 'string' || header.length === 0 || header.length > 16384
                || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(header)) throw new Error();
            const der = Buffer.from(header, 'base64');
            if (der.toString('base64') !== header) throw new Error();
            const certificate = new X509Certificate(der);
            // OpenSSL acepta datos sobrantes: exigir exactamente un certificado DER.
            if (!certificate.raw.equals(der)) throw new Error();
            const now = Date.now();
            const from = Date.parse(certificate.validFrom);
            const to = Date.parse(certificate.validTo);
            if (!Number.isFinite(from) || !Number.isFinite(to) || now < from || now > to
                || !allowed.has(certificate.fingerprint.replaceAll(':', '').toUpperCase())) throw new Error();
            next();
        } catch {
            res.status(403).json({ error: 'APIM_CERTIFICATE_REQUIRED', message: 'Certificado de cliente no autorizado.' });
        }
    };
}
