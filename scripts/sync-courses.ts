import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { reconcile } from './course-sync/reconcile.js';
import { testRun, testSnapshot } from '../test/fixtures/course-sync.test.js';

export function runSyncDemo(args: string[]) {
    if (new Set(args).size !== args.length || args.some(a => !['--dry-run', '--fixture'].includes(a))) {
        throw new Error('Solo se admite --dry-run --fixture.');
    }
    return { dataSource: 'TEST_SYNTHETIC_ONLY', databaseAccess: false, publicationApproved: false,
        ...reconcile(testSnapshot(), testRun()) };
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
    try { console.log(JSON.stringify(runSyncDemo(process.argv.slice(2)), null, 2)); }
    catch { console.error('Usar courses:sync -- --dry-run --fixture; no hay modo live ni apply.'); process.exitCode = 1; }
}
