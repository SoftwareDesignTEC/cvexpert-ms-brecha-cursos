// Synthetic RDF metadata, never represented as real courses or editorial approval.
import { openLearnType } from '../course-discovery/openlearn-provider.js';
export function fixtureTransport(): typeof fetch {
    const uri = (value: string) => ({ type: 'uri',value });
    const literal = (value: string) => ({ type: 'literal',value });
    const rows = Array.from({ length: 12 },(_,i) => {
        const id = String(980001 + i), path = `test-incremental/test-${id}/content-section-0`;
        return { resource: uri(`http://data.open.ac.uk/openlearn/${path}`),type: uri(openLearnType),title: literal(`[TEST] Incremental ${id}`),
            url: uri(`https://www.open.edu/openlearn/${path}`),internalId: literal(id),subject: literal('[TEST] Category A') };
    });
    rows.push({ ...rows[0]!,subject: literal('[TEST] Category B') });
    return async input => {
        const q = new URL(String(input)).searchParams.get('query')!;
        let vars: string[], bindings: unknown[];
        if (q.startsWith('SELECT DISTINCT ?resource')) {
            const cursor = q.match(/FILTER\(STR\(\?resource\) > "([^"]+)"\)/)?.[1] ?? '';
            const limit = Number(q.match(/LIMIT (\d+)$/)?.[1]);
            vars = ['resource']; bindings = [...new Set(rows.map(r => r.resource.value))].sort().filter(r => r > cursor).slice(0,limit).map(r => ({ resource: uri(r) }));
        } else {
            const ids = [...q.matchAll(/<http:\/\/data\.open\.ac\.uk\/openlearn\/[^>]+>/g)].map(m => m[0].slice(1,-1));
            const selected = rows.filter(r => ids.includes(r.resource.value));
            vars = ['resource','type','title','url','internalId','subject','rowCount'];
            bindings = selected.map(r => ({ ...r,rowCount: literal(String(selected.filter(other => other.resource.value === r.resource.value).length)) }));
        }
        return new Response(JSON.stringify({ head: { vars },results: { bindings } }),{ headers: { 'content-type': 'application/sparql-results+json' } });
    };
}
