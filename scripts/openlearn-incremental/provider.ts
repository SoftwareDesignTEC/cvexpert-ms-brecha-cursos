import { createHash } from 'node:crypto';
import { DiscoveryError, text } from '../course-discovery/model.js';
import { openLearnEndpoint, openLearnGraph, openLearnType, parseOpenLearnRecord,
    candidateFromOpenLearnRecord, type OpenLearnRecord } from '../course-discovery/openlearn-provider.js';
import { fromDiscovery, type SyncRun } from '../course-sync/model.js';
import { timestamp } from '../course-sync/validation.js';

export const maxMetadataRows = 200;
const pattern = `VALUES ?type { <${openLearnType}> }
  ?resource a ?type ; <http://purl.org/dc/terms/title> ?title ; <http://dbpedia.org/property/url> ?url .
  FILTER(STRSTARTS(STR(?url), "https://www.open.edu/openlearn/") && STRENDS(STR(?url), "/content-section-0"))`;
const metadata = `${pattern}
  OPTIONAL { ?resource <http://data.open.ac.uk/openlearn/ontology/internalID> ?internalId }
  OPTIONAL { ?resource <http://data.open.ac.uk/openlearn/ontology/primaryTerm> ?subject }`;
export function resource(value: unknown): string {
    if (typeof value !== 'string' || value.length > 512 || !/^http:\/\/data\.open\.ac\.uk\/openlearn\/[a-z0-9-]+(?:\/[a-z0-9-]+)*\/content-section-0$/.test(value)) throw new DiscoveryError('INVALID_RESOURCE_CURSOR');
    return value;
}
export function identityQuery(cursor: string | null, size: number): string {
    if (!Number.isInteger(size) || size < 1 || size > 10) throw new DiscoveryError('INVALID_PAGE_SIZE');
    return `SELECT DISTINCT ?resource FROM <${openLearnGraph}> WHERE {
  ${pattern}
  FILTER(isIRI(?resource))
  ${cursor === null ? '' : `FILTER(STR(?resource) > ${JSON.stringify(resource(cursor))})`}
} ORDER BY STR(?resource) LIMIT ${size}`;
}
export function metadataQuery(ids: string[]): string {
    if (!ids.length || ids.length > 10 || new Set(ids).size !== ids.length) throw new DiscoveryError('INVALID_IDENTITIES');
    const values = `VALUES ?resource { ${ids.map(id => `<${resource(id)}>`).join(' ')} }`;
    return `SELECT ?resource ?type ?title ?url ?internalId ?subject ?rowCount FROM <${openLearnGraph}> WHERE {
  ${values}
  { SELECT ?resource (COUNT(*) AS ?rowCount) WHERE { ${values} ${metadata} } GROUP BY ?resource }
  ${metadata}
} ORDER BY STR(?resource) STR(?title) STR(?url) STR(?internalId) STR(?subject) LIMIT ${maxMetadataRows + 1}`;
}
export const queryVersion = 'openlearn-keyset-v1-' + createHash('sha256').update(
    `${openLearnEndpoint}|${identityQuery(null,10)}|${metadataQuery(['http://data.open.ac.uk/openlearn/version/content-section-0'])}|strict-parser-v1`).digest('hex');
export interface RequestEvidence { query: string; querySha256: string; at: string; status: number | null; bytes: number; responseSha256: string | null }
export interface IncrementalArtifact {
    formatVersion: 1; provider: 'openlearn'; queryVersion: string; cursorBefore: string | null; cursorNext: string | null;
    advanceAllowed: boolean; exhausted: boolean; resources: string[]; records: OpenLearnRecord[];
    requests: RequestEvidence[]; editorialConflicts: { url: string; code: 'EDITORIAL_IDENTITY_REVIEW_REQUIRED' }[]; run: SyncRun;
}
function object(v: unknown): Record<string,unknown> {
    if (!v || typeof v !== 'object' || Array.isArray(v)) throw new DiscoveryError('INVALID_SPARQL_RESPONSE');
    return v as Record<string,unknown>;
}
function bindings(body: unknown, vars: string[], limit: number): Record<string,unknown>[] {
    const b = object(body), head = object(b.head), results = object(b.results);
    if (Object.keys(b).some(k => !['head','results','meta'].includes(k)) || Object.keys(head).some(k => k !== 'vars')
        || !Array.isArray(head.vars) || head.vars.length !== vars.length || new Set(head.vars).size !== vars.length
        || vars.some(v => !(head.vars as unknown[]).includes(v)) || Object.keys(results).some(k => k !== 'bindings')
        || !Array.isArray(results.bindings) || results.bindings.length > limit) throw new DiscoveryError('INCOMPLETE_RESPONSE');
    if (b.meta !== undefined) {
        const meta = object(b.meta);
        if (Object.keys(meta).some(k => !['query-time-ms','result-size-total'].includes(k))
            || meta['result-size-total'] !== undefined && meta['result-size-total'] !== results.bindings.length) throw new DiscoveryError('INCOMPLETE_RESPONSE');
    }
    return results.bindings.map(object);
}
async function requestJson(query: string, request: typeof fetch, evidence: RequestEvidence[], beforeRequest: () => Promise<void>, now: () => number, timeoutMs: number) {
    await beforeRequest(); // Durable reservation and spacing happen before the socket.
    const e: RequestEvidence = { query,querySha256: createHash('sha256').update(query).digest('hex'),
        at: new Date(now()).toISOString(),status: null,bytes: 0,responseSha256: null };
    evidence.push(e);
    const url = new URL(openLearnEndpoint); url.searchParams.set('query',query);
    const controller = new AbortController(); let timer: ReturnType<typeof setTimeout> | undefined;
    const work = async () => {
        const response = await request(url.href,{ method: 'GET',redirect: 'error',credentials: 'omit',
            headers: { Accept: 'application/sparql-results+json' },signal: controller.signal });
        e.status = response.status;
        const cancel = () => { void response.body?.cancel().catch(() => {}); };
        if (response.redirected || response.url && response.url !== url.href || response.status >= 300 && response.status < 400) { cancel(); throw new DiscoveryError('UNSAFE_REDIRECT'); }
        if (!response.ok) {
            const retry = response.headers.get('retry-after');
            const seconds = retry && /^\d+$/.test(retry) ? Number(retry) * 1000 : retry ? Date.parse(retry) - now() : 0;
            const delay = Number.isFinite(seconds) && seconds >= 0 ? Math.min(Number.MAX_SAFE_INTEGER - now(),Math.max(60000,seconds)) : 86400000;
            cancel();
            if (response.status === 429) throw new DiscoveryError('RATE_LIMITED',delay);
            if (response.status >= 500) throw new DiscoveryError('PROVIDER_UNAVAILABLE',Math.max(delay,300000));
            throw new DiscoveryError('PROVIDER_HTTP_ERROR');
        }
        if (response.status !== 200 || response.headers.has('x-sparql-maxrows')) { cancel(); throw new DiscoveryError('INCOMPLETE_RESPONSE'); }
        if (!/^application\/sparql-results\+json(?:\s*;|$)/i.test(response.headers.get('content-type') ?? '')) { cancel(); throw new DiscoveryError('INVALID_CONTENT_TYPE'); }
        const reader = response.body?.getReader(); if (!reader) throw new DiscoveryError('INVALID_SPARQL_RESPONSE');
        const parts: Uint8Array[] = []; const abort = () => { void reader.cancel().catch(() => {}); };
        controller.signal.addEventListener('abort',abort,{ once: true });
        try {
            while (true) {
                const part = await reader.read(); controller.signal.throwIfAborted(); if (part.done) break;
                e.bytes += part.value.byteLength; if (e.bytes > 256 * 1024) throw new DiscoveryError('RESPONSE_TOO_LARGE'); parts.push(part.value);
            }
        } finally { controller.signal.removeEventListener('abort',abort); void reader.cancel().catch(() => {}); reader.releaseLock(); }
        const buffer = Buffer.concat(parts); e.responseSha256 = createHash('sha256').update(buffer).digest('hex');
        try { return JSON.parse(new TextDecoder('utf-8',{ fatal: true }).decode(buffer)) as unknown; }
        catch { throw new DiscoveryError('INVALID_SPARQL_RESPONSE'); }
    };
    try { return await Promise.race([work(),new Promise<never>((_,reject) => {
        timer = setTimeout(() => { controller.abort(); reject(new DiscoveryError('TIMEOUT')); },timeoutMs);
    })]); } catch (e) { throw e instanceof DiscoveryError ? e : new DiscoveryError('PROVIDER_NETWORK_ERROR'); }
    finally { clearTimeout(timer); controller.abort(); }
}
export async function preparePage(input: { cursor: string | null; size: number; runId: string; observedAt: string }, request: typeof fetch,
    beforeRequest: () => Promise<void>, editorialUrls: Set<string>, now: () => number = Date.now, timeoutMs = 15000): Promise<IncrementalArtifact> {
    if (!Number.isInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 15000) throw new DiscoveryError('INVALID_TIMEOUT');
    text(input.runId); timestamp(input.observedAt);
    const select = identityQuery(input.cursor,input.size); // Validate all caller input before reserving or sending HTTP.
    const artifact: IncrementalArtifact = { formatVersion: 1,provider: 'openlearn',queryVersion,cursorBefore: input.cursor,cursorNext: input.cursor,
        advanceAllowed: false,exhausted: false,resources: [],records: [],requests: [],editorialConflicts: [],
        run: { runId: input.runId,sourceId: 'openlearn',observedAt: input.observedAt,scope: 'query',status: 'partial',valid: true,
            missingPages: true,quotaLimited: false,errors: [],candidates: [] } };
    try {
        const selected = bindings(await requestJson(select,request,artifact.requests,beforeRequest,now,timeoutMs),['resource'],input.size);
        const ids = selected.map(b => {
            if (Object.keys(b).length !== 1) throw new DiscoveryError('INVALID_IDENTITIES');
            const node = object(b.resource); if (node.type !== 'uri' || Object.keys(node).sort().join(',') !== 'type,value') throw new DiscoveryError('INVALID_IDENTITIES');
            return resource(node.value);
        });
        if (new Set(ids).size !== ids.length || ids.some((id,i) => (i ? ids[i-1]! : input.cursor) !== null && id <= (i ? ids[i-1]! : input.cursor!))) throw new DiscoveryError('NON_MONOTONIC_CURSOR');
        artifact.resources = ids;
        if (!ids.length) { artifact.exhausted = true; artifact.advanceAllowed = true; return artifact; }
        const data = bindings(await requestJson(metadataQuery(ids),request,artifact.requests,beforeRequest,now,timeoutMs),
            ['resource','type','title','url','internalId','subject','rowCount'],maxMetadataRows);
        const counts = new Map<string,number>(), expected = new Map<string,number>();
        for (const row of data) {
            const count = object(row.rowCount);
            if (count.type !== 'literal' || typeof count.value !== 'string' || !/^[1-9]\d{0,2}$/.test(count.value)
                || Number(count.value) > maxMetadataRows) throw new DiscoveryError('INVALID_METADATA_COUNT');
            const { rowCount: _count,...raw } = row;
            const record = parseOpenLearnRecord(raw);
            if (!ids.includes(record.resource) || expected.has(record.resource) && expected.get(record.resource) !== Number(count.value)) throw new DiscoveryError('UNEXPECTED_RESOURCE');
            expected.set(record.resource,Number(count.value)); counts.set(record.resource,(counts.get(record.resource) ?? 0) + 1);
            artifact.records.push(record);
        }
        if (ids.some(id => !expected.has(id) || expected.get(id) !== counts.get(id))) throw new DiscoveryError('INCOMPLETE_METADATA');
        artifact.cursorNext = ids.at(-1)!; artifact.advanceAllowed = true;
        const hash = artifact.requests.at(-1)!.responseSha256!;
        artifact.run.candidates = artifact.records.map(r => {
            const c = fromDiscovery(candidateFromOpenLearnRecord(r,input.observedAt,hash));
            c.evidence[0]!.summary = `RDF resource ${r.resource}; query ${artifact.requests.at(-1)!.querySha256}`;
            if (editorialUrls.has(c.canonicalUrl)) {
                c.validation = 'conflict';
                artifact.editorialConflicts.push({ url: c.canonicalUrl,code: 'EDITORIAL_IDENTITY_REVIEW_REQUIRED' });
                artifact.run.errors.push('EDITORIAL_IDENTITY_REVIEW_REQUIRED');
            }
            return c;
        });
        return artifact;
    } catch (error) {
        const safe = error instanceof DiscoveryError ? error : new DiscoveryError('INVALID_PAGE');
        artifact.advanceAllowed = false; artifact.cursorNext = input.cursor;
        artifact.run = { ...artifact.run,status: 'failed',valid: false,quotaLimited: safe.code === 'RATE_LIMITED',errors: [safe.code],candidates: [] };
        throw new PageError(safe.code,safe.retryAfterMs,artifact);
    }
}
export class PageError extends DiscoveryError {
    constructor(code: string, retryAfterMs: number, public readonly artifact: IncrementalArtifact) { super(code,retryAfterMs); }
}
