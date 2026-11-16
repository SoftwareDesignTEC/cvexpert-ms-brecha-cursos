import { readFileSync } from 'node:fs';
import { fccRef, openLearnQuery } from '../../src/ingestion/providers.js';

// Minimal captured descriptive metadata; never a claim that tests queried the network.
export const automaticSnapshot = JSON.parse(readFileSync(new URL('./automatic-courses.test.json',import.meta.url),'utf8'));
export function automaticTransport(snapshot = structuredClone(automaticSnapshot)): typeof fetch {
    return async input => {
        const url = new URL(String(input)); let body: string;
        if (url.origin === 'https://data.open.ac.uk') {
            if (url.pathname !== '/sparql' || url.searchParams.get('query') !== openLearnQuery) throw Error('UNEXPECTED_QUERY');
            body = JSON.stringify(snapshot.openlearn);
        } else if (url.href === fccRef) body = JSON.stringify(snapshot.ref);
        else if (url.href === `https://raw.githubusercontent.com/freeCodeCamp/freeCodeCamp/${snapshot.ref.object.sha}/README.md`) body = snapshot.readme;
        else if (url.href === `https://raw.githubusercontent.com/freeCodeCamp/freeCodeCamp/${snapshot.ref.object.sha}/client/i18n/locales/english/intro.json`) body = JSON.stringify(snapshot.intro);
        else throw Error('EXTERNAL_NETWORK_FORBIDDEN');
        return new Response(body,{ headers: { 'content-type': 'application/json' } });
    };
}
