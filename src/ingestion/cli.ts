import 'dotenv/config';
import { ingestConfigured } from './runtime.js';
import { IngestError } from './providers.js';

if (process.argv.length !== 2) {
    console.error('ARGUMENTS_NOT_SUPPORTED'); process.exitCode = 1;
} else {
    ingestConfigured().then(report => {
        console.log(JSON.stringify(report,null,2));
        if (report.status === 'failed' || report.status === 'partial') process.exitCode = 1;
    }).catch(e => { console.error(JSON.stringify({ error: e instanceof IngestError ? e.code : 'COURSES_INGEST_FAILED' })); process.exitCode = 1; });
}
