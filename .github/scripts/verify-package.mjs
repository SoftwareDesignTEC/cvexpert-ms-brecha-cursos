import assert from 'node:assert/strict';
import { execFileSync, spawn } from 'node:child_process';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { setTimeout } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';

export function validateEntries(entries) {
    const required = ['dist/server.js', 'dist/app.js', 'package.json', 'package-lock.json',
        'node_modules/express/package.json', 'node_modules/dotenv/package.json', 'node_modules/pg/package.json'];
    for (const entry of required) assert.ok(entries.includes(entry), `ZIP missing ${entry}`);
    for (const entry of entries) {
        assert.ok(!entry.includes('\\') && !entry.startsWith('/') && !entry.split('/').includes('..'), 'Unsafe ZIP path');
        assert.ok(['dist', 'node_modules', 'package.json', 'package-lock.json'].includes(entry.split('/')[0]),
            `Unexpected ZIP root: ${entry}`);
        assert.ok(!/(^|\/)(\.env[^/]*|\.git|\.npmrc|migrations|seeds|credentials[^/]*)(\/|$)/i.test(entry)
            && !/\.(sql|pem|key|pfx|p12|publishsettings)$/i.test(entry), `Sensitive or administrative file: ${entry}`);
        assert.ok(!/^dist\/db\/(cli|migrate|seed)\.js$/.test(entry), `Administrative CLI in ZIP: ${entry}`);
    }
}

async function freePort() {
    const probe = createServer();
    await new Promise((resolve, reject) => {
        probe.once('error', reject);
        probe.listen(0, '127.0.0.1', resolve);
    });
    const { port } = probe.address();
    await new Promise((resolve, reject) => probe.close(error => error ? reject(error) : resolve()));
    return port;
}

async function smokeTest(directory) {
    const port = await freePort();
    // Intentionally do not inherit PG*, Azure, GitHub tokens or the workspace .env.
    const child = spawn(process.execPath, ['dist/server.js'], {
        cwd: directory,
        env: { NODE_ENV: 'production', PORT: String(port) },
        stdio: ['ignore', 'pipe', 'pipe'],
    });
    let output = '';
    let spawnError;
    child.on('error', error => { spawnError = error; });
    const closed = new Promise(resolve => child.once('close', resolve));
    for (const stream of [child.stdout, child.stderr]) {
        stream.on('data', chunk => { output = (output + chunk).slice(-4000); });
    }
    try {
        const deadline = Date.now() + 15000;
        let response;
        while (Date.now() < deadline) {
            if (spawnError) throw spawnError;
            if (child.exitCode !== null || child.signalCode !== null) throw new Error(`Packaged server exited: ${output}`);
            try {
                response = await fetch(`http://127.0.0.1:${port}/health`, { signal: AbortSignal.timeout(1000) });
                break;
            } catch { await setTimeout(50); }
        }
        assert.ok(response, `Packaged server did not become healthy: ${output}`);
        assert.equal(response.status, 200);
        assert.deepEqual(await response.json(), { status: 'ok', service: 'brecha-cursos' });
        const demo = await fetch(`http://127.0.0.1:${port}/skills-gap`, { signal: AbortSignal.timeout(1000) });
        assert.equal(demo.status, 503, 'Production must not publish demo recommendations.');
    } finally {
        child.kill('SIGTERM');
        await Promise.race([closed, setTimeout(2000, undefined, { ref: false })]);
        if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
        await closed;
    }
}

export async function verifyPackage(zipFile) {
    const archive = resolve(zipFile);
    const entries = execFileSync('unzip', ['-Z1', archive], { encoding: 'utf8' }).trim().split('\n');
    validateEntries(entries);
    const directory = await mkdtemp(join(tmpdir(), 'cvexpert-zip-check-'));
    try {
        execFileSync('unzip', ['-q', archive, '-d', directory]);
        const manifest = JSON.parse(await readFile(join(directory, 'package.json'), 'utf8'));
        for (const dependency of Object.keys(manifest.dependencies)) {
            await readFile(join(directory, 'node_modules', dependency, 'package.json'));
        }
        await smokeTest(directory);
        console.log('ZIP verified: compiled server, production dependencies, restricted paths, /health=200 and /skills-gap=503.');
    } finally {
        // This path was created here by mkdtemp, exclusively for ZIP extraction.
        await rm(directory, { recursive: true, force: true });
    }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
    await verifyPackage(process.argv[2]);
}
