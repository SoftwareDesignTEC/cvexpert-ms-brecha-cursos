import { execFileSync } from 'node:child_process';
import { appendFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const options = { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] };
const target = '/resourceGroups/rg-cvexpert/providers/Microsoft.Web/sites/cvexpert-ms-brecha-cursos';
const readFailure = 'A required read-only Azure query failed. Check target, login and scoped permissions.';
const expectedClientId = 'c7ca60cb-216c-4a31-993b-618ad3bb0923';

export function validateVariables(env) {
    for (const name of ['AZURE_CLIENT_ID', 'AZURE_TENANT_ID', 'AZURE_SUBSCRIPTION_ID']) {
        if (!/^[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}$/i.test(env[name] ?? '')) {
            throw new Error(`Error de configuración de variables: ${name} ausente o inválida.`);
        }
    }
    // Configuration allowlist only; azure/login must authenticate this identity with OIDC.
    if (env.AZURE_CLIENT_ID.toLowerCase() !== expectedClientId) {
        throw new Error('Error de configuración de variables: AZURE_CLIENT_ID no corresponde a la identidad de despliegue esperada.');
    }
    if (env.AZURE_BACKEND_NETWORK_MODEL !== 'public-mtls') {
        throw new Error('Error de configuración de variables: AZURE_BACKEND_NETWORK_MODEL ausente o distinto de public-mtls.');
    }
}

export function checkAccess(env, execute = execFileSync) {
    validateVariables(env);
    try {
        const az = args => JSON.parse(execute('az', [...args, '--only-show-errors', '--output', 'json'], options));
        const account = az(['account', 'show', '--query', '{id:id,tenantId:tenantId}']);
        if (account?.id?.toLowerCase() !== env.AZURE_SUBSCRIPTION_ID.toLowerCase()
            || account?.tenantId?.toLowerCase() !== env.AZURE_TENANT_ID.toLowerCase()) throw new Error();
        const site = az(['webapp', 'show', '--subscription', env.AZURE_SUBSCRIPTION_ID,
            '--resource-group', 'rg-cvexpert', '--name', 'cvexpert-ms-brecha-cursos', '--query', 'id']);
        const expected = `/subscriptions/${env.AZURE_SUBSCRIPTION_ID}${target}`;
        if (typeof site !== 'string' || site.toLowerCase() !== expected.toLowerCase()) throw new Error();
    } catch {
        throw new Error('Error de permisos o acceso: sesión, suscripción, tenant o App Service esperado no verificable.');
    }
}

export function checkPreflight(env, execute = execFileSync) {
    validateVariables(env);
    try {
        execute(process.execPath, [fileURLToPath(new URL('./azure-preflight.mjs', import.meta.url))],
            { ...options, env: { ...env } });
    } catch (error) {
        // Discard all child output, including unexpected errors that could carry sensitive data.
        if (String(error.stderr).trim() === readFailure) {
            throw Object.assign(new Error('Error de permisos o acceso: una lectura requerida por el preflight falló.'), { kind: 'access' });
        }
        throw Object.assign(new Error('Fallo de preflight: revisar la configuración requerida por azure-preflight.mjs.'), { kind: 'preflight' });
    }
}

export function diagnosticResult(env) {
    if (env.CONFIGURATION_OUTCOME === 'failure') return 'Error de configuración de variables.';
    if (env.LOGIN_OUTCOME === 'failure') return 'Error de autenticación OIDC.';
    if (env.ACCESS_OUTCOME === 'failure') return 'Error de permisos o acceso.';
    if (env.PREFLIGHT_OUTCOME === 'failure') return env.PREFLIGHT_FAILURE_KIND === 'access'
        ? 'Error de permisos o acceso: una lectura requerida por el preflight falló.' : 'Fallo de preflight.';
    if (['CONFIGURATION', 'LOGIN', 'ACCESS', 'PREFLIGHT'].every(key => env[`${key}_OUTCOME`] === 'success')) {
        return 'Diagnóstico completado. OIDC, acceso al App Service y preflight public-mtls verificados; sin despliegue.';
    }
    return 'Diagnóstico incompleto: revisar preparación del runner, pasos omitidos o cancelación.';
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
    try {
        switch (process.argv[2]) {
            case 'configuration': validateVariables(process.env); break;
            case 'access': checkAccess(process.env); break;
            case 'preflight': checkPreflight(process.env); break;
            case 'summary': {
                const result = diagnosticResult(process.env);
                console.log(result);
                appendFileSync(process.env.GITHUB_STEP_SUMMARY, `${result}\n`);
                break;
            }
            default: throw new Error('Modo de diagnóstico inválido.');
        }
    } catch (error) {
        if (process.argv[2] === 'preflight' && process.env.GITHUB_OUTPUT) {
            appendFileSync(process.env.GITHUB_OUTPUT, `failure_kind=${error.kind === 'access' ? 'access' : 'preflight'}\n`);
        }
        console.error(error.message);
        process.exitCode = 1;
    }
}
