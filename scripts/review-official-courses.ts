import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { readJson } from './course-discovery/store.js';
import { editorialContentHash, prepareEditorialCatalog, reviewTemplate } from './editorial-courses/review.js';

export async function runOfficialReview(args: string[]) {
    const [command,...options] = args;
    if (!['report','template','hash','catalog'].includes(command ?? '')) throw new Error('Use report|template|hash|catalog --file <registry> [--review <review>]');
    const values = new Map<string,string>();
    for (let i = 0; i < options.length; i += 2) {
        const key = options[i]!, value = options[i + 1];
        if (!['--file','--review'].includes(key) || values.has(key) || !value || value.startsWith('--')) throw new Error('INVALID_ARGUMENTS');
        values.set(key,value);
    }
    if (!values.has('--file')) throw new Error('REGISTRY_REQUIRED');
    const registry = await readJson(values.get('--file')!);
    const review = values.has('--review') ? await readJson(values.get('--review')!) : undefined;
    if (command === 'template') return reviewTemplate(registry);
    if (command === 'hash') {
        if (!review) throw new Error('REVIEW_REQUIRED');
        return { contentSha256: editorialContentHash(registry,review),authorizedToPublish: false };
    }
    const report = prepareEditorialCatalog(registry,review);
    if (command === 'catalog') {
        if (report.purpose === 'TEST_ONLY' || !report.catalog) throw new Error('NO_OPERATIONAL_CATALOG_ELIGIBLE');
        return report.catalog;
    }
    return report;
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
    runOfficialReview(process.argv.slice(2)).then(r => console.log(JSON.stringify(r,null,2)))
        .catch(() => { console.error('OFFICIAL_COURSES_REVIEW_FAILED'); process.exitCode = 1; });
}
