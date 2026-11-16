import { fileURLToPath, pathToFileURL } from 'node:url';
import { Pool } from 'pg';
import { readJson } from './course-discovery/store.js';
import { DiscoveryError } from './course-discovery/model.js';
import { localSyncConfig } from './sync-courses-local.js';
import { createPostgresStaging } from './course-sync/postgres.js';
import { fixtureTransport } from './openlearn-incremental/fixture.js';
import { preparePage, resource } from './openlearn-incremental/provider.js';
import { initialize, status, fetchPage, applyPage } from './openlearn-incremental/session.js';

export async function editorialUrls(): Promise<Set<string>> {
    const registry = await readJson(fileURLToPath(new URL('../docs/providers/openlearn-real-courses.json',import.meta.url))) as { candidates: { url: string; aliases: string[] }[] };
    return new Set(registry.candidates.flatMap(c => [c.url,...c.aliases]));
}
export async function incrementalCli(args: string[], env = process.env) {
    if (!args.length || args.length === 1 && args[0] === 'fixture') {
        const artifact = await preparePage({ cursor: null,size: 10,runId: 'TEST-incremental-preview',observedAt: '2026-11-16T00:00:00.000Z' },
            fixtureTransport(),async () => {},await editorialUrls());
        return { mode: 'fixture-preview',databaseAccess: false,externalRequests: 0,artifact };
    }
    const [command,...rest] = args, options = new Map<string,string>();
    const permitted: Record<string,string[]> = {
        init: ['--cursor','--authorize-source','--pages','--page-size','--requests','--pause-ms'],
        fetch: ['--authorize-source'],status: [],'apply-local': [],'history-local': [],
    };
    if (!command || !Object.hasOwn(permitted,command)) throw new DiscoveryError('INVALID_ARGUMENTS');
    for (let i = 0; i < rest.length; i += 2) {
        if (!['--root','--mode',...permitted[command]!].includes(rest[i]!)
            || rest[i+1] === undefined || options.has(rest[i]!)) throw new DiscoveryError('INVALID_ARGUMENTS');
        options.set(rest[i]!,rest[i+1]!);
    }
    const root = options.get('--root'), mode = options.get('--mode') ?? 'fixture', auth = options.get('--authorize-source') ?? null;
    if (!root || !['fixture','live'].includes(mode)) throw new DiscoveryError('INVALID_ARGUMENTS');
    if (mode === 'live' && ['init','fetch'].includes(command!) && (env.NODE_ENV !== 'development' || env.CI || env.GITHUB_ACTIONS
        || env.TF_BUILD || env.WEBSITE_INSTANCE_ID || env.WEBSITE_SITE_NAME)) throw new DiscoveryError('LOCAL_PILOT_ONLY');
    if (mode === 'live' && ['init','fetch'].includes(command!) && !auth) throw new DiscoveryError('EXPLICIT_SOURCE_AUTHORIZATION_REQUIRED');
    const m = mode as 'fixture' | 'live';
    if (command === 'init') {
        const cursor = options.get('--cursor'); if (!cursor) throw new DiscoveryError('EXPLICIT_INITIAL_CURSOR_REQUIRED');
        return initialize(root,m,cursor === 'start' ? null : resource(cursor),auth,{
            pageSize: Number(options.get('--page-size') ?? 10),maxPages: Number(options.get('--pages') ?? 1),
            maxRequests: Number(options.get('--requests') ?? 2),minIntervalMs: Number(options.get('--pause-ms') ?? 5000) });
    }
    if (command === 'status') return status(root,m);
    if (command === 'fetch') return fetchPage(root,m,auth,{ request: m === 'fixture' ? fixtureTransport() : fetch,editorialUrls: await editorialUrls() });
    if (!['apply-local','history-local'].includes(command!)) throw new DiscoveryError('INVALID_ARGUMENTS');
    const config = localSyncConfig(env), pool = new Pool(config);
    try {
        const staging = createPostgresStaging(pool);
        if (command === 'history-local') return staging.history('openlearn');
        const host = config.host === '::1' ? '[::1]' : config.host;
        return applyPage(root,m,staging,`${host}:${config.port}:${config.database}:${config.user}`);
    } finally { await pool.end(); }
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
    incrementalCli(process.argv.slice(2)).then(report => { console.log(JSON.stringify(report,null,2));
        if ('run' in report && report.run.status === 'failed') process.exitCode = 1;
    }).catch(e => { console.error(e instanceof DiscoveryError ? e.code : 'OPENLEARN_INCREMENTAL_FAILED'); process.exitCode = 1; });
}
