import 'dotenv/config';
import { lookup } from 'node:dns/promises';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { Pool } from 'pg';
import { getDatabaseConfig } from '../src/db/config.js';
import { readJsonFile } from './import-market.js';
import { MarketImportError } from './market-import/document.js';
import { CatalogImportError, parseCatalogDocument } from './catalog-import/document.js';
import { assertCatalogMaintenance, CatalogConflictError, importCatalog } from './catalog-import/importer.js';

export function parseArguments(args: string[]) {
    let file: string | undefined, apply = false;
    const seen = new Set<string>();
    for (let i = 0; i < args.length; i++) {
        const arg = args[i]!;
        if (!['--file', '--apply'].includes(arg) || seen.has(arg)) throw new CatalogImportError('Opción desconocida o repetida.');
        seen.add(arg);
        if (arg === '--apply') apply = true;
        else { file = args[++i]; if (!file || file.startsWith('--')) throw new CatalogImportError('Falta archivo JSON.'); }
    }
    if (!file) throw new CatalogImportError('Usa --file <archivo.json> [--apply].');
    return { file, apply };
}
export async function readCatalogFile(file: string) {
    try { return parseCatalogDocument(await readJsonFile(file)); }
    catch (error) {
        if (error instanceof MarketImportError) throw new CatalogImportError(error.message);
        throw error;
    }
}
export async function runCatalogImport(args: string[], env = process.env) {
    const options = parseArguments(args);
    assertCatalogMaintenance(env);
    const document = await readCatalogFile(options.file);
    const config = getDatabaseConfig(env);
    // Resuelve localhost y fija una dirección numérica antes de abrir un socket.
    const addresses = await lookup(String(config.host), { all: true });
    if (!addresses.length || addresses.some(a => !['127.0.0.1', '::1'].includes(a.address))) {
        throw new CatalogImportError('El destino resuelto no es loopback.');
    }
    const pool = new Pool({ ...config, host: addresses[0]!.address });
    pool.on('error', () => console.error('Conexión local de mantenimiento interrumpida.'));
    try { return await importCatalog(pool, document, options, env); }
    finally { await pool.end(); }
}
export function safeImportError(error: unknown): string {
    return error instanceof CatalogImportError ? error.message : 'Falló la importación; no se publican detalles de conexión, SQL ni credenciales.';
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
    runCatalogImport(process.argv.slice(2)).then(report => console.log(JSON.stringify(report, null, 2))).catch(error => {
        if (error instanceof CatalogConflictError) console.log(JSON.stringify(error.report, null, 2));
        console.error(safeImportError(error));
        process.exitCode = 1;
    });
}
