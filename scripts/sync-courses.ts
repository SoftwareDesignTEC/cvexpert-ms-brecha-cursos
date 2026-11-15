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
export async function runCourseSync(args: string[]) {
    const providerIndex = args.indexOf('--provider');
    if (providerIndex < 0) return runSyncDemo(args);
    if (args[providerIndex + 1] !== 'saylor' || args.lastIndexOf('--provider') !== providerIndex) throw new Error('INVALID_PROVIDER');
    const { runSaylorDemo } = await import('./course-sync/saylor-demo.js');
    return runSaylorDemo(args.filter((_, i) => i !== providerIndex && i !== providerIndex + 1));
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
    runCourseSync(process.argv.slice(2)).then(report => console.log(JSON.stringify(report, null, 2))).catch(() => {
        console.error('Usar courses:sync -- [--provider saylor] --dry-run --fixture; no hay modo live ni apply.'); process.exitCode = 1;
    });
}
