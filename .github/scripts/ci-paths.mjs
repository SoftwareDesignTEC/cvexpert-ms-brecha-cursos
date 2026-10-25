import { execFileSync } from 'node:child_process';
import { appendFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

// An allowlist for skips, not an allowlist for code: new/unknown paths run CI.
export function requiresCi(paths) {
    return paths.length === 0 || paths.some(path =>
        path !== 'README.md' && !(path.startsWith('docs/') && path.endsWith('.md')));
}

export function classifyChanges(eventName, base, head) {
    // All pushes (develop and main) execute the full suite, even for docs-only changes.
    if (eventName !== 'pull_request') return true;
    if (![base, head].every(sha => /^[a-f0-9]{40}$/.test(sha ?? ''))) {
        throw new Error('Missing or invalid PR revisions; refusing to skip CI.');
    }
    const files = execFileSync('git', ['diff', '--name-only', '--no-renames', '-z', `${base}...${head}`],
        { encoding: 'utf8' }).split('\0').filter(Boolean);
    return requiresCi(files);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
    const run = classifyChanges(process.env.EVENT_NAME, process.env.BASE_SHA, process.env.HEAD_SHA);
    appendFileSync(process.env.GITHUB_OUTPUT, `run=${run}\n`);
    console.log(run ? 'Full CI required.' : 'Only known documentation paths changed.');
}
