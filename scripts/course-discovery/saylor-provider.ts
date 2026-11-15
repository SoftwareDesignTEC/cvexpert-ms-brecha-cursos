import { createHash } from 'node:crypto';
import { DiscoveryError, text, type CourseCandidate, type CourseDiscoveryProvider, type CourseTopic } from './model.js';

export const saylorApi = 'https://learn.saylor.org/webservice/rest/server.php';
export const saylorFunction = 'local_wsfunc_get_visible_courses';
export interface SaylorQuery extends CourseTopic { categoryId: number }
interface Options { mode?: 'fixture' | 'live'; timeoutMs?: number; maxResponseBytes?: number; maxRecords?: number }
interface Batch { received: number; accepted: number; rejected: number; duplicateIds: number }

export function saylorCourseUrl(value: unknown): string {
    const raw = text(value), parsed = new URL(raw);
    if (!/^https:\/\/learn\.saylor\.org\/course\/view\.php\?id=[1-9][0-9]*$/u.test(raw)
        || parsed.origin !== 'https://learn.saylor.org') throw new DiscoveryError('UNSAFE_COURSE_URL');
    return parsed.href;
}
function integer(value: unknown, minimum = 1): number {
    if (!Number.isSafeInteger(value) || Number(value) < minimum) throw new DiscoveryError('INVALID_RECORD');
    return value as number;
}

// Fixture transport is explicit and trusted. There is NO default fetch, token reader,
// credential parameter or enabled live path. Real access requires a separate reviewed change.
export class SaylorProvider implements CourseDiscoveryProvider<SaylorQuery> {
    readonly name = 'saylor';
    private readonly timeoutMs: number;
    private readonly maxResponseBytes: number;
    private readonly maxRecords: number;
    private batch: Batch | null = null;
    get lastBatch(): Batch | null { return this.batch && { ...this.batch }; }

    constructor(private readonly options: Options = {}, private readonly request?: typeof fetch,
        private readonly now: () => number = Date.now) {
        this.timeoutMs = options.timeoutMs ?? 10000;
        this.maxResponseBytes = options.maxResponseBytes ?? 1024 * 1024;
        this.maxRecords = options.maxRecords ?? 1000;
        for (const [value, maximum] of [[this.timeoutMs, 30000], [this.maxResponseBytes, 1024 * 1024], [this.maxRecords, 10000]]) {
            if (!Number.isSafeInteger(value) || value! < 1 || value! > maximum!) throw new DiscoveryError('INVALID_CONFIG');
        }
    }

    async search(query: SaylorQuery, beforeRequest: () => Promise<void>) {
        this.batch = null;
        if (this.options.mode !== 'fixture' || !this.request) throw new DiscoveryError('SAYLOR_LIVE_DISABLED');
        text(query.skill, 200); integer(query.categoryId, 0);
        // One documented request per search. The existing coordinator owns run/day budgets
        // and persistent backoff. Reserve before transport, including failed attempts.
        await beforeRequest();
        const controller = new AbortController();
        let timer: ReturnType<typeof setTimeout> | undefined;
        const deadline = new Promise<never>((_, reject) => {
            timer = setTimeout(() => { controller.abort(); reject(new DiscoveryError('TIMEOUT')); }, this.timeoutMs);
        });
        const work = async () => {
            const response = await this.request!(saylorApi, { method: 'POST', redirect: 'error', signal: controller.signal,
                headers: { Accept: 'application/json', 'Content-Type': 'application/x-www-form-urlencoded' },
                body: new URLSearchParams({ wsfunction: saylorFunction, moodlewsrestformat: 'json', cat: String(query.categoryId) }) });
            if (controller.signal.aborted) {
                void response.body?.cancel().catch(() => {}); controller.signal.throwIfAborted();
            }
            if (response.redirected || (response.url && response.url !== saylorApi) || (response.status >= 300 && response.status < 400)) {
                void response.body?.cancel().catch(() => {}); throw new DiscoveryError('UNSAFE_REDIRECT');
            }
            if (!response.ok) {
                void response.body?.cancel().catch(() => {});
                if ([401, 403].includes(response.status)) throw new DiscoveryError('PROVIDER_UNAUTHORIZED');
                const retry = response.headers.get('retry-after');
                const wait = retry && /^\d+$/u.test(retry) ? Number(retry) * 1000 : retry ? Date.parse(retry) - this.now() : 0;
                const backoff = Math.min(86400000, Math.max(60000, Number.isFinite(wait) ? wait : 0));
                if (response.status === 429) throw new DiscoveryError('RATE_LIMITED', backoff);
                if (response.status >= 500) throw new DiscoveryError('PROVIDER_UNAVAILABLE', Math.max(300000, backoff));
                throw new DiscoveryError('PROVIDER_HTTP_ERROR');
            }
            if (!/^application\/json(?:\s*;|$)/iu.test(response.headers.get('content-type') ?? '')) {
                void response.body?.cancel().catch(() => {}); throw new DiscoveryError('INVALID_RESPONSE');
            }
            const reader = response.body?.getReader();
            if (!reader) throw new DiscoveryError('INVALID_RESPONSE');
            const chunks: Uint8Array[] = [];
            let length = 0;
            const abort = () => { void reader.cancel().catch(() => {}); };
            controller.signal.addEventListener('abort', abort, { once: true });
            try {
                while (true) {
                    const { done, value } = await reader.read();
                    controller.signal.throwIfAborted();
                    if (done) break;
                    length += value.byteLength;
                    if (length > this.maxResponseBytes) throw new DiscoveryError('RESPONSE_TOO_LARGE');
                    chunks.push(value);
                }
            } finally {
                controller.signal.removeEventListener('abort', abort);
                void reader.cancel().catch(() => {}); reader.releaseLock();
            }
            const bytes = Buffer.concat(chunks);
            let body: unknown;
            try { body = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)); }
            catch { throw new DiscoveryError('INVALID_RESPONSE'); }
            if (!body || typeof body !== 'object' || Array.isArray(body) || Object.keys(body).some(k => k !== 'courses')
                || !Array.isArray((body as { courses?: unknown }).courses)) throw new DiscoveryError('INVALID_RESPONSE');
            const rows = (body as { courses: unknown[] }).courses;
            if (rows.length > this.maxRecords) throw new DiscoveryError('RECORD_LIMIT_EXCEEDED');
            const queriedAt = new Date(this.now()).toISOString();
            const digest = createHash('sha256').update(bytes).digest('hex');
            const candidates: CourseCandidate[] = [], seen = new Set<string>();
            let rejected = 0, duplicateIds = 0;
            for (const raw of rows) {
                try {
                    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new DiscoveryError('INVALID_RECORD');
                    const row = raw as Record<string, unknown>;
                    // Only the documented visible-courses fields. Do not accept invented
                    // price/language/duration/url fields as verified provider metadata.
                    if (Object.keys(row).some(k => !['id', 'category', 'shortname', 'fullname', 'startdate', 'summary'].includes(k))) throw new DiscoveryError('UNRECOGNIZED_RECORD');
                    const externalId = String(integer(row.id)), category = String(integer(row.category, 0));
                    const title = text(row.fullname); text(row.shortname, 512);
                    if (row.startdate != null) text(row.startdate, 100);
                    if (row.summary != null && typeof row.summary !== 'string') throw new DiscoveryError('INVALID_RECORD');
                    const url = saylorCourseUrl(`https://learn.saylor.org/course/view.php?id=${externalId}`);
                    if (seen.has(externalId)) duplicateIds++; seen.add(externalId);
                    candidates.push({ source: this.name, externalId, title, platform: 'Saylor University', url, canonicalUrl: url,
                        associatedSkills: [], queriedAt, language: null, levels: [], durationMinutes: null, isPaid: null,
                        validation: 'needs_review', reviewReasons: ['TEST_SYNTHETIC_ONLY', 'SKILL_ASSOCIATIONS_REQUIRE_REVIEW',
                            'PRICE_AND_OPTIONAL_SERVICES_UNKNOWN', 'TEACHING_LANGUAGE_UNKNOWN', 'COURSE_URL_DERIVED_FROM_ID',
                            'COVERAGE_UNVERIFIED', 'PUBLICATION_NOT_APPROVED'],
                        evidence: [{ apiUrl: saylorApi, responseSha256: digest, summary: null, products: [],
                            subjects: [`saylor:category:${category}`], returnedUrl: url, title, queriedAt,
                            durationMinutes: null, language: null, levels: [] }] });
                } catch { rejected++; }
            }
            this.batch = { received: rows.length, accepted: candidates.length, rejected, duplicateIds };
            // No pagination or completeness attestation is documented. Even cat=0/[]
            // remains incomplete for disappearance decisions. Never follow unknown cursors.
            return { candidates, rejected, truncated: true };
        };
        try { return await Promise.race([work(), deadline]); }
        catch (error) { throw error instanceof DiscoveryError ? error : new DiscoveryError('PROVIDER_NETWORK_ERROR'); }
        finally { clearTimeout(timer); controller.abort(); }
    }
}
