import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { Pool } from 'pg';
import { readJsonFile } from './import-market.js';
import { AdminImportError, administrativeConfig, parseTarget } from './admin-import/config.js';
import { planAdministrativeImport, prepareInput, sha256 } from './admin-import/planner.js';

export function parseAdminArguments(args: string[]) {
    const paths: Record<string, string> = {};
    let connectAzure = false;
    const seen = new Set<string>();
    for (let i = 0; i < args.length; i++) {
        const key = args[i]!;
        if (seen.has(key)) throw new AdminImportError('Opción administrativa repetida.');
        seen.add(key);
        if (key === '--connect-azure') { connectAzure = true; continue; }
        if (!['--target', '--catalog', '--market', '--scale'].includes(key)) throw new AdminImportError('Opción no permitida; solo validación offline o dry-run.');
        const path = args[++i];
        if (!path || path.startsWith('--')) throw new AdminImportError('Falta archivo administrativo.');
        paths[key] = path;
    }
    if (Object.keys(paths).length !== 4) throw new AdminImportError('Requiere --target --catalog --market --scale; --connect-azure habilita solo lectura.');
    return { paths, connectAzure };
}

export async function runAdministrativeImport(args: string[], env = process.env) {
    const { paths, connectAzure } = parseAdminArguments(args);
    const [targetValue, catalog, market, scale] = await Promise.all(
        ['--target', '--catalog', '--market', '--scale'].map(key => readJsonFile(paths[key]!)));
    const target = parseTarget(targetValue);
    const input = prepareInput(catalog, market, scale);
    if (!connectAzure) return { mode: 'offline-validation', target, inputSha256: sha256(input),
        databaseChecked: false, applyAvailable: false };
    const pool = new Pool(administrativeConfig(target, env));
    pool.on('error', () => console.error('Sesión administrativa interrumpida.'));
    try { return await planAdministrativeImport(pool, target, input); }
    finally { await pool.end(); }
}

export const safeAdministrativeError = (_error: unknown) =>
    'Procedimiento administrativo rechazado; verificar entradas, destino, TLS, identidad, permisos e historial. No se publican errores del driver ni credenciales.';

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
    runAdministrativeImport(process.argv.slice(2)).then(report => {
        console.log(JSON.stringify(report, null, 2));
        if ('summary' in report && report.summary.conflicts) process.exitCode = 2;
    }).catch(error => { console.error(safeAdministrativeError(error)); process.exitCode = 1; });
}
