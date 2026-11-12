import { randomUUID } from 'node:crypto';
import { lstat, mkdir, open, realpath, rename, unlink } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { DiscoveryError, type CourseCandidate } from './model.js';

export interface DiscoveryState {
    version: 1; day: string; requests: number; lastRequestAt: number; blockedUntil: number; lastRunAt: number;
    cache: Record<string, { queriedAt: number; candidates: CourseCandidate[]; rejected: number; truncated: boolean }>;
}
export function emptyState(): DiscoveryState {
    return { version: 1, day: '', requests: 0, lastRequestAt: 0, blockedUntil: 0, lastRunAt: 0, cache: {} };
}
export interface DiscoveryStore {
    load(): Promise<DiscoveryState>;
    save(state: DiscoveryState): Promise<void>;
}

export async function readJson(path: string, maxBytes = 1024 * 1024): Promise<unknown> {
    if (!(await lstat(path)).isFile()) throw new DiscoveryError('INVALID_FILE');
    const handle = await open(path, 'r');
    try {
        if (!(await handle.stat()).isFile()) throw new DiscoveryError('INVALID_FILE');
        const buffer = Buffer.alloc(maxBytes + 1);
        let length = 0;
        while (length < buffer.length) {
            const { bytesRead } = await handle.read(buffer, length, buffer.length - length);
            if (!bytesRead) break;
            length += bytesRead;
        }
        if (length > maxBytes) throw new DiscoveryError('FILE_TOO_LARGE');
        const source = new TextDecoder('utf-8', { fatal: true }).decode(buffer.subarray(0, length));
        const value: unknown = JSON.parse(source);
        // También rechaza claves equivalentes con escapes; no aplica last-write-wins.
        const tokens = source.match(/"(?:[^"\\]|\\[\s\S])*"|[{}\[\]:,]/g) ?? [];
        const stack: (Set<string> | null)[] = [];
        for (let i = 0; i < tokens.length; i++) {
            const token = tokens[i]!;
            if (token === '{') stack.push(new Set());
            else if (token === '[') stack.push(null);
            else if (token === '}' || token === ']') stack.pop();
            else if (token.startsWith('"') && tokens[i + 1] === ':') {
                const key = JSON.parse(token) as string;
                if (stack.at(-1)?.has(key)) throw new DiscoveryError('DUPLICATE_JSON_KEY');
                stack.at(-1)?.add(key);
            }
        }
        return value;
    } finally { await handle.close(); }
}

// Un único dueño por directorio; contador persistido antes de cada solicitud.
// Un lock abandonado requiere revisión manual, nunca se rompe automáticamente.
export async function withDiscoveryStore<T>(root: string, mode: 'fixture' | 'live',
    work: (store: DiscoveryStore, writeReport: (report: unknown) => Promise<void>) => Promise<T>): Promise<T> {
    const directory = resolve(root, 'local-catalog-input', 'discovery');
    await mkdir(directory, { recursive: true, mode: 0o700 });
    if ((await realpath(directory)).toLowerCase() !== directory.toLowerCase()) throw new DiscoveryError('UNSAFE_DIRECTORY');
    const lockPath = join(directory, `${mode}.lock`);
    let lock;
    try { lock = await open(lockPath, 'wx', 0o600); }
    catch { throw new DiscoveryError('DISCOVERY_LOCKED'); }
    const atomicWrite = async (name: string, value: unknown) => {
        const content = JSON.stringify(value, null, 2) + '\n';
        if (Buffer.byteLength(content) > 16 * 1024 * 1024) throw new DiscoveryError('STATE_TOO_LARGE');
        const temporary = join(directory, `${randomUUID()}.tmp`);
        const file = await open(temporary, 'wx', 0o600);
        try {
            await file.writeFile(content, 'utf8');
            await file.sync();
            await file.close();
            await rename(temporary, join(directory, name));
        } finally { await file.close(); await unlink(temporary).catch(() => {}); }
    };
    const store: DiscoveryStore = {
        async load() {
            let raw: unknown;
            try { raw = await readJson(join(directory, `${mode}-state.json`), 16 * 1024 * 1024); }
            catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return emptyState(); throw error; }
            const state = raw as DiscoveryState;
            if (!state || state.version !== 1 || typeof state.day !== 'string'
                || (state.day !== '' && !/^\d{4}-\d{2}-\d{2}$/u.test(state.day))
                || (state.day === '' && state.requests !== 0)
                || !['requests', 'lastRequestAt', 'blockedUntil', 'lastRunAt'].every(key =>
                    Number.isSafeInteger(state[key as 'requests']) && state[key as 'requests'] >= 0)
                || !state.cache || typeof state.cache !== 'object' || Array.isArray(state.cache)
                || Object.keys(state.cache).length > 20) throw new DiscoveryError('INVALID_STATE');
            // La caché es un archivo de mantenimiento local confiable, no una entrada HTTP.
            for (const entry of Object.values(state.cache)) {
                if (!entry || !Number.isSafeInteger(entry.queriedAt) || !Array.isArray(entry.candidates)
                    || entry.candidates.length > 500 || !Number.isInteger(entry.rejected)
                    || typeof entry.truncated !== 'boolean') throw new DiscoveryError('INVALID_STATE');
            }
            return state;
        },
        save: state => atomicWrite(`${mode}-state.json`, state),
    };
    try { return await work(store, report => atomicWrite(`latest-${mode}.json`, report)); }
    finally { await lock.close(); await unlink(lockPath); }
}
