import { resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { parseCatalogDocument } from './catalog-import/document.js';
import { DiscoveryError, parseDiscoveryConfig, skillKey } from './course-discovery/model.js';
import { LearnPlatformProvider } from './course-discovery/learn-provider.js';
import { discoverCourses } from './course-discovery/service.js';
import { readJson, withDiscoveryStore } from './course-discovery/store.js';

export function parseDiscoveryArguments(args: string[]) {
    const options: { live: boolean; scheduled: boolean; config?: string; catalog?: string; skill?: string } = { live: false, scheduled: false };
    const seen = new Set<string>();
    for (let i = 0; i < args.length; i++) {
        const arg = args[i]!;
        if (seen.has(arg) || !['--dry-run', '--fixture', '--live', '--scheduled', '--config', '--catalog', '--skill'].includes(arg)) throw new DiscoveryError('INVALID_ARGUMENTS');
        seen.add(arg);
        if (arg === '--live') options.live = true;
        else if (arg === '--scheduled') options.scheduled = true;
        else if (['--config', '--catalog', '--skill'].includes(arg)) {
            const value = args[++i];
            if (!value || value.startsWith('--')) throw new DiscoveryError('INVALID_ARGUMENTS');
            options[arg.slice(2) as 'config' | 'catalog' | 'skill'] = value;
        }
    }
    if ((options.live && seen.has('--fixture')) || (options.live && !options.config)) throw new DiscoveryError('INVALID_ARGUMENTS');
    return options;
}

export async function runDiscovery(args: string[], env: NodeJS.ProcessEnv = process.env, root = process.cwd()) {
    const options = parseDiscoveryArguments(args);
    if (env.NODE_ENV === 'production' || env.WEBSITE_INSTANCE_ID || env.WEBSITE_SITE_NAME) throw new DiscoveryError('LOCAL_MAINTENANCE_ONLY');
    const config = parseDiscoveryConfig(await readJson(options.config ?? fileURLToPath(new URL('../test/fixtures/course-discovery/config.json', import.meta.url))));
    if (options.skill !== undefined) {
        if (!options.skill.trim() || options.skill.length > 200 || /[\p{Cc}\p{Cf}\p{Cs}]/u.test(options.skill)) throw new DiscoveryError('INVALID_INPUT');
        config.queries = config.queries.filter(query => skillKey(query.skill) === skillKey(options.skill!));
        if (!config.queries.length) throw new DiscoveryError('UNCONFIGURED_SKILL');
    }
    const mode = options.live ? 'live' : 'fixture';
    const catalog = options.catalog ? parseCatalogDocument(await readJson(options.catalog)) : undefined;
    // Un tick desactivado no necesita ni lee tokens. No se carga .env implícitamente.
    if (options.live && !(options.scheduled && !config.enabled)
        && (!config.enabled || env.COURSE_DISCOVERY_STORAGE_APPROVED !== 'true')) throw new DiscoveryError('LIVE_DISCOVERY_NOT_AUTHORIZED');
    if (options.live && !(options.scheduled && !config.enabled) && !env.LEARN_ACCESS_TOKEN) throw new DiscoveryError('CREDENTIALS_REQUIRED');
    const fixture = options.live ? undefined : await readJson(fileURLToPath(new URL('../test/fixtures/course-discovery/modules.json', import.meta.url)));
    const fixtureClock = () => Date.parse('2026-11-11T12:00:00.000Z');
    const clock = options.live ? Date.now : fixtureClock;
    const provider = new LearnPlatformProvider(config,
        async () => options.live ? env.LEARN_ACCESS_TOKEN ?? '' : 'fixture-token-not-a-credential',
        options.live ? fetch : async () => new Response(JSON.stringify(fixture), { headers: { 'content-type': 'application/json' } }), clock);
    return withDiscoveryStore(root, mode, async (store, writeReport) => {
        const report = await discoverCourses(provider, config, store, { mode, scheduled: options.scheduled, catalog }, clock,
            options.live ? undefined : async () => {});
        await writeReport(report);
        return report;
    });
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
    runDiscovery(process.argv.slice(2)).then(report => {
        console.log(JSON.stringify({ status: report.status, candidates: report.candidates.length,
            evidence: `local-catalog-input/discovery/latest-${report.dataSource === 'deterministic_test_fixture' ? 'fixture' : 'live'}.json`,
            publicationApproved: false, databaseAccess: false }));
        if (['partial_failure', 'provider_backoff'].includes(report.status)) process.exitCode = 1;
    }).catch(error => {
        console.error(JSON.stringify({ error: error instanceof DiscoveryError ? error.code : 'DISCOVERY_FAILED' }));
        process.exitCode = 1;
    });
}
