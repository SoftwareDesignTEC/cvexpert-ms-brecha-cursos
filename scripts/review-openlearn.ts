import { open } from 'node:fs/promises';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { preparePilot } from './openlearn-enrichment/review.js';

export async function runReview(args: string[]) {
    if (args.length !== 3 || !['report', 'catalog'].includes(args[0]!) || args[1] !== '--file' || !args[2] || args[2].startsWith('--')) {
        throw new Error('Usar report|catalog --file <piloto.json>. Solo lectura offline.');
    }
    const handle = await open(args[2], 'r');
    let value: unknown;
    try {
        if (!(await handle.stat()).isFile()) throw new Error('Se requiere un archivo regular.');
        const buffer = Buffer.alloc(1048577); let length = 0;
        while (length < buffer.length) { const { bytesRead } = await handle.read(buffer, length, buffer.length - length); if (!bytesRead) break; length += bytesRead; }
        if (length > 1048576) throw new Error('Máximo 1 MiB.');
        const source = new TextDecoder('utf-8', { fatal: true }).decode(buffer.subarray(0, length));
        value = JSON.parse(source);
        // Reject repeated keys, including escaped equivalents, after grammar validation.
        const tokens = source.match(/"(?:[^"\\]|\\[\s\S])*"|[{}\[\]:,]/g) ?? [], stack: (Set<string> | null)[] = [];
        for (let i = 0; i < tokens.length; i++) {
            const t = tokens[i]!;
            if (t === '{') stack.push(new Set()); else if (t === '[') stack.push(null);
            else if (t === '}' || t === ']') stack.pop();
            else if (t.startsWith('"') && tokens[i + 1] === ':') { const key = JSON.parse(t) as string, keys = stack.at(-1); if (keys?.has(key)) throw new Error('Clave duplicada.'); keys?.add(key); }
        }
    } finally { await handle.close(); }
    const report = preparePilot(value);
    if (args[0] === 'catalog') { if (!report.catalog) throw new Error('Sin cursos revisados elegibles. Consultar report.'); return report.catalog; }
    return report;
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
    runReview(process.argv.slice(2)).then(result => process.stdout.write(JSON.stringify(result, null, 2) + '\n')).catch(() => {
        process.stderr.write('Revisión rechazada: comprobar formato, evidencia, bloqueos y aprobación explícita.\n'); process.exitCode = 1;
    });
}
