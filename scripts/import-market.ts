import 'dotenv/config';
import { open } from 'node:fs/promises';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { createDatabasePool } from '../src/db/pool.js';
import { MarketImportError, parseScale } from './market-import/document.js';
import { assertLocalMaintenance, importMarketRequirements } from './market-import/importer.js';

export function parseArguments(args: string[]) {
    let file: string | undefined, scaleFile: string | undefined, apply = false, allowUpdates = false;
    const seen = new Set<string>();
    for (let i = 0; i < args.length; i++) {
        const arg = args[i]!;
        if (!['--file', '--scale', '--apply', '--allow-updates'].includes(arg) || seen.has(arg)) throw new MarketImportError('Opción desconocida o repetida.');
        seen.add(arg);
        if (arg === '--apply') apply = true;
        else if (arg === '--allow-updates') allowUpdates = true;
        else {
            const value = args[++i];
            if (!value || value.startsWith('--')) throw new MarketImportError('Falta la ruta del archivo.');
            if (arg === '--file') file = value; else scaleFile = value;
        }
    }
    if (!file || !scaleFile || (allowUpdates && !apply)) throw new MarketImportError('Usa --file <JSON> --scale <JSON> [--apply [--allow-updates]].');
    return { file, scaleFile, apply, allowUpdates };
}

export async function readJsonFile(path: string): Promise<unknown> {
    const handle = await open(path, 'r');
    try {
        // Lectura acotada incluso si el archivo crece después del stat.
        if (!(await handle.stat()).isFile()) throw new MarketImportError('La entrada debe ser un archivo JSON regular.');
        const buffer = Buffer.alloc(1024 * 1024 + 1);
        let length = 0;
        while (length < buffer.length) {
            const { bytesRead } = await handle.read(buffer, length, buffer.length - length);
            if (!bytesRead) break;
            length += bytesRead;
        }
        if (length > 1024 * 1024) throw new MarketImportError('El archivo JSON supera 1 MiB.');
        let source: string, parsed: unknown;
        try {
            source = new TextDecoder('utf-8', { fatal: true }).decode(buffer.subarray(0, length));
            parsed = JSON.parse(source);
        } catch { throw new MarketImportError('Archivo JSON o UTF-8 inválido.'); }
        // JSON.parse acepta claves repetidas y conserva la última. Tras validar la
        // gramática, revisamos las claves de cada objeto, incluidos escapes equivalentes.
        const tokens = source.match(/"(?:[^"\\]|\\[\s\S])*"|[{}\[\]:,]/g) ?? [];
        const stack: (Set<string> | null)[] = [];
        for (let i = 0; i < tokens.length; i++) {
            const token = tokens[i]!;
            if (token === '{') stack.push(new Set());
            else if (token === '[') stack.push(null);
            else if (token === '}' || token === ']') stack.pop();
            else if (token.startsWith('"') && tokens[i + 1] === ':') {
                const key = JSON.parse(token) as string, keys = stack.at(-1)!;
                if (keys?.has(key)) throw new MarketImportError('Claves JSON duplicadas; no se conserva implícitamente la última.');
                keys?.add(key);
            }
        }
        return parsed;
    } finally { await handle.close(); }
}

export async function runMarketImport(args: string[]) {
    const env = process.env;
    const options = parseArguments(args);
    assertLocalMaintenance(env);
    const scale = parseScale(await readJsonFile(options.scaleFile));
    const document = await readJsonFile(options.file);
    // La CLI usa el mismo entorno validado por assertLocalMaintenance.
    const pool = createDatabasePool();
    try { return await importMarketRequirements(pool, document, scale, options, env); }
    finally { await pool.end(); }
}

export function safeImportError(error: unknown): string {
    return error instanceof MarketImportError ? error.message : 'Falló la importación local; no se publican detalles de conexión, SQL ni credenciales.';
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
    runMarketImport(process.argv.slice(2)).then(report => console.log(JSON.stringify(report, null, 2))).catch(error => {
        console.error(safeImportError(error));
        process.exitCode = 1;
    });
}
