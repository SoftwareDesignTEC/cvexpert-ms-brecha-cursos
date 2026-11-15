import { createHash } from 'node:crypto';
import { DiscoveryError, text, type CourseCandidate, type CourseDiscoveryProvider, type CourseTopic } from './model.js';

export const openLearnEndpoint = 'https://data.open.ac.uk/sparql';
export const openLearnGraph = 'http://data.open.ac.uk/context/openlearn2';
export const openLearnType = 'http://data.open.ac.uk/openlearn/ontology/OpenCourseware';
export const openLearnLimit = 10;
// Verified vocabulary, fixed graph, fixed SELECT and hard cap. No user interpolation,
// OFFSET, federation, graph fallback, HTML scraping or exhaustive traversal.
export const openLearnSelect = `SELECT ?resource ?type ?title ?url ?internalId ?subject
FROM <${openLearnGraph}>
WHERE {
  VALUES ?type { <${openLearnType}> }
  ?resource a ?type ; <http://purl.org/dc/terms/title> ?title ; <http://dbpedia.org/property/url> ?url .
  FILTER(STRSTARTS(STR(?url), "https://www.open.edu/openlearn/") && STRENDS(STR(?url), "/content-section-0"))
  OPTIONAL { ?resource <http://data.open.ac.uk/openlearn/ontology/internalID> ?internalId }
  OPTIONAL { ?resource <http://data.open.ac.uk/openlearn/ontology/primaryTerm> ?subject }
}
ORDER BY ?resource
LIMIT 10`;
const variables = ['resource', 'type', 'title', 'url', 'internalId', 'subject'];
type RecordValue = Record<string, unknown>;
export interface OpenLearnRecord { resource: string; type: string; title: string; url: string; internalId: string | null; subject: string | null }
export interface OpenLearnObservation {
    at: string; status: number; bytes: number; responseSha256: string; received: number; accepted: number;
    duplicateIds: number; rejected: { index: number; code: string }[]; records: OpenLearnRecord[];
}
interface Options { mode?: 'fixture' | 'live'; timeoutMs?: number; maxResponseBytes?: number }

function object(value: unknown): RecordValue {
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw new DiscoveryError('INVALID_SPARQL_RESPONSE');
    return value as RecordValue;
}
function term(value: unknown, type: 'uri' | 'literal'): string {
    const node = object(value);
    if (node.type !== type || Object.keys(node).some(k => !['type', 'value', 'datatype', 'xml:lang'].includes(k))) throw new DiscoveryError('INVALID_RDF_TERM');
    if (type === 'uri' && (node.datatype !== undefined || node['xml:lang'] !== undefined)) throw new DiscoveryError('INVALID_RDF_TERM');
    if (node.datatype !== undefined) text(node.datatype);
    if (node['xml:lang'] !== undefined) text(node['xml:lang'], 100);
    return text(node.value);
}
export function openLearnCourseUrl(value: unknown): string {
    const raw = text(value);
    if (!/^https:\/\/www\.open\.edu\/openlearn\/[a-z0-9-]+(?:\/[a-z0-9-]+)*\/content-section-0$/u.test(raw)) throw new DiscoveryError('UNSAFE_COURSE_URL');
    return raw; // Preserve the supplied URL. Never invent a URL or upgrade legacy HTTP links.
}
function parseRecord(value: unknown): OpenLearnRecord {
    const row = object(value);
    if (Object.keys(row).some(k => !variables.includes(k))) throw new DiscoveryError('UNEXPECTED_BINDING');
    const resource = term(row.resource, 'uri');
    if (!/^http:\/\/data\.open\.ac\.uk\/openlearn\/[a-z0-9-]+(?:\/[a-z0-9-]+)*\/content-section-0$/u.test(resource)) throw new DiscoveryError('UNSAFE_RESOURCE_ID');
    const type = term(row.type, 'uri');
    if (type !== openLearnType) throw new DiscoveryError('NOT_OPENCOURSEWARE');
    const internalId = row.internalId === undefined ? null : term(row.internalId, 'literal');
    if (internalId !== null && !/^[1-9][0-9]{0,19}$/u.test(internalId)) throw new DiscoveryError('INVALID_EXTERNAL_ID');
    return { resource, type, internalId, title: term(row.title, 'literal'), url: openLearnCourseUrl(term(row.url, 'uri')),
        subject: row.subject === undefined ? null : term(row.subject, 'literal') };
}

export class OpenLearnProvider implements CourseDiscoveryProvider<CourseTopic> {
    readonly name = 'openlearn';
    private attempts = 0;
    private observation: OpenLearnObservation | null = null;
    private readonly mode: 'fixture' | 'live';
    private readonly request: typeof fetch | undefined;
    private readonly timeoutMs: number;
    private readonly maxResponseBytes: number;
    get requests(): number { return this.attempts; }
    get lastObservation(): OpenLearnObservation | null { return this.observation && structuredClone(this.observation); }
    constructor(options: Options = {}, request?: typeof fetch, private readonly now: () => number = Date.now) {
        this.mode = options.mode ?? 'fixture';
        if (!['fixture', 'live'].includes(this.mode)) throw new DiscoveryError('INVALID_CONFIG');
        this.request = request ?? (this.mode === 'live' ? fetch : undefined);
        this.timeoutMs = options.timeoutMs ?? 15000;
        this.maxResponseBytes = options.maxResponseBytes ?? 256 * 1024;
        if (!Number.isInteger(this.timeoutMs) || this.timeoutMs < 1 || this.timeoutMs > 15000
            || !Number.isInteger(this.maxResponseBytes) || this.maxResponseBytes < 1 || this.maxResponseBytes > 256 * 1024) throw new DiscoveryError('INVALID_CONFIG');
    }

    async search(query: CourseTopic, beforeRequest: () => Promise<void>) {
        text(query.skill, 200); // Context only; never inserted into SPARQL or skills.
        if (!this.request) throw new DiscoveryError('FIXTURE_TRANSPORT_REQUIRED');
        if (this.attempts >= 1) throw new DiscoveryError('QUERY_BUDGET_EXHAUSTED');
        this.attempts++; // Synchronous reservation also prevents concurrent requests.
        await beforeRequest();
        const url = new URL(openLearnEndpoint); url.searchParams.set('query', openLearnSelect);
        const controller = new AbortController();
        let timer: ReturnType<typeof setTimeout> | undefined;
        const timeout = new Promise<never>((_, reject) => {
            timer = setTimeout(() => { controller.abort(); reject(new DiscoveryError('TIMEOUT')); }, this.timeoutMs);
        });
        const work = async () => {
            const response = await this.request!(url.href, { method: 'GET', redirect: 'error', credentials: 'omit',
                headers: { Accept: 'application/sparql-results+json' }, signal: controller.signal });
            if (controller.signal.aborted) { void response.body?.cancel().catch(() => {}); controller.signal.throwIfAborted(); }
            const cancel = () => { void response.body?.cancel().catch(() => {}); };
            if (response.redirected || (response.url && response.url !== url.href) || (response.status >= 300 && response.status < 400)) {
                cancel(); throw new DiscoveryError('UNSAFE_REDIRECT');
            }
            if (!response.ok) {
                cancel();
                if ([401, 403].includes(response.status)) throw new DiscoveryError('PROVIDER_UNAUTHORIZED');
                const retry = response.headers.get('retry-after');
                const wait = retry && /^\d+$/u.test(retry) ? Number(retry) * 1000 : retry ? Date.parse(retry) - this.now() : 0;
                const delay = Math.min(86400000, Math.max(60000, Number.isFinite(wait) ? wait : 0));
                if (response.status === 429) throw new DiscoveryError('RATE_LIMITED', delay);
                if (response.status >= 500) throw new DiscoveryError('PROVIDER_UNAVAILABLE', Math.max(300000, delay));
                throw new DiscoveryError('PROVIDER_HTTP_ERROR');
            }
            if (response.status !== 200 || response.headers.has('x-sparql-maxrows')) { cancel(); throw new DiscoveryError('INCOMPLETE_RESPONSE'); }
            if (!/^application\/sparql-results\+json(?:\s*;|$)/iu.test(response.headers.get('content-type') ?? '')) {
                cancel(); throw new DiscoveryError('INVALID_CONTENT_TYPE');
            }
            const reader = response.body?.getReader();
            if (!reader) throw new DiscoveryError('INVALID_SPARQL_RESPONSE');
            const parts: Uint8Array[] = []; let bytes = 0;
            const abort = () => { void reader.cancel().catch(() => {}); };
            controller.signal.addEventListener('abort', abort, { once: true });
            try {
                while (true) {
                    const item = await reader.read(); controller.signal.throwIfAborted();
                    if (item.done) break;
                    bytes += item.value.byteLength;
                    if (bytes > this.maxResponseBytes) throw new DiscoveryError('RESPONSE_TOO_LARGE');
                    parts.push(item.value);
                }
            } finally {
                controller.signal.removeEventListener('abort', abort);
                void reader.cancel().catch(() => {}); reader.releaseLock();
            }
            const buffer = Buffer.concat(parts);
            let body: RecordValue;
            try { body = object(JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(buffer))); }
            catch { throw new DiscoveryError('INVALID_SPARQL_RESPONSE'); }
            const head = object(body.head), results = object(body.results), names = head.vars;
            if (Object.keys(body).some(k => !['head', 'results', 'meta'].includes(k)) || Object.keys(head).some(k => k !== 'vars')
                || !Array.isArray(names) || names.length !== variables.length || variables.some(v => !names.includes(v))
                || Object.keys(results).some(k => k !== 'bindings') || !Array.isArray(results.bindings)) throw new DiscoveryError('INVALID_SPARQL_RESPONSE');
            if (results.bindings.length > openLearnLimit) throw new DiscoveryError('RECORD_LIMIT_EXCEEDED');
            if (body.meta !== undefined) {
                const meta = object(body.meta);
                if (Object.keys(meta).some(k => !['query-time-ms', 'result-size-total'].includes(k))
                    || (meta['result-size-total'] !== undefined && meta['result-size-total'] !== results.bindings.length)) throw new DiscoveryError('INCOMPLETE_RESPONSE');
            }
            const at = new Date(this.now()).toISOString(), responseSha256 = createHash('sha256').update(buffer).digest('hex');
            const records: OpenLearnRecord[] = [], candidates: CourseCandidate[] = [], rejected: OpenLearnObservation['rejected'] = [];
            const ids = new Set<string>(); let duplicateIds = 0;
            for (const [index, raw] of results.bindings.entries()) {
                try {
                    const record = parseRecord(raw), externalId = record.internalId ?? record.resource;
                    records.push(record);
                    if (ids.has(externalId)) duplicateIds++; ids.add(externalId);
                    candidates.push({ source: this.name, externalId, title: record.title, platform: 'OpenLearn — The Open University',
                        url: record.url, canonicalUrl: record.url, associatedSkills: [], language: null, levels: [], durationMinutes: null,
                        isPaid: null, queriedAt: at, validation: 'needs_review', reviewReasons: ['PUBLICATION_NOT_APPROVED',
                            'CURRENT_COURSE_STATUS_NOT_VERIFIED', 'PRICE_LANGUAGE_DURATION_LEVEL_UNVERIFIED', 'SKILLS_REQUIRE_EDITORIAL_REVIEW'],
                        evidence: [{ apiUrl: openLearnEndpoint, responseSha256, title: record.title, returnedUrl: record.url, queriedAt: at,
                            summary: null, products: [], subjects: record.subject === null ? [] : [record.subject],
                            durationMinutes: null, language: null, levels: [] }] });
                } catch (error) { rejected.push({ index, code: error instanceof DiscoveryError ? error.code : 'INVALID_RECORD' }); }
            }
            this.observation = { at, status: 200, bytes, responseSha256, received: results.bindings.length, accepted: candidates.length,
                rejected, duplicateIds, records };
            return { candidates, rejected: rejected.length, truncated: true };
        };
        try { return await Promise.race([work(), timeout]); }
        catch (error) { throw error instanceof DiscoveryError ? error : new DiscoveryError('PROVIDER_NETWORK_ERROR'); }
        finally { clearTimeout(timer); controller.abort(); }
    }
}
