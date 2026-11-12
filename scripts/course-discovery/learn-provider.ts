import { createHash } from 'node:crypto';
import { CourseDiscoveryProvider, CourseCandidate, DiscoveryConfig, DiscoveryError, DiscoveryQuery, safeCourseUrl, text } from './model.js';

export const learnApi = 'https://learn.microsoft.com/api/v1/modules';
export const learnVersion = '2023-11-01-preview';
type JsonRecord = Record<string, unknown>;
function object(value: unknown): JsonRecord {
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw new DiscoveryError('INVALID_RESPONSE');
    return value as JsonRecord;
}
function taxonomy(value: unknown): string[] {
    if (value === undefined || value === null) return [];
    if (!Array.isArray(value) || value.length > 100) throw new DiscoveryError('INVALID_RESPONSE');
    return value.map(item => text(object(item).id, 200));
}

export class LearnPlatformProvider implements CourseDiscoveryProvider {
    readonly name = 'microsoft-learn-v1';
    constructor(private readonly config: DiscoveryConfig,
        private readonly getToken: (signal: AbortSignal) => Promise<string>,
        private readonly request: typeof fetch = fetch,
        private readonly now: () => number = Date.now) {}

    private async page(url: string, beforeRequest: () => Promise<void>) {
        await beforeRequest();
        const controller = new AbortController();
        let timer: ReturnType<typeof setTimeout> | undefined;
        const timeout = new Promise<never>((_, reject) => {
            timer = setTimeout(() => { controller.abort(); reject(new DiscoveryError('TIMEOUT')); }, this.config.timeoutMs);
        });
        const work = async () => {
            const token = await this.getToken(controller.signal);
            controller.signal.throwIfAborted();
            if (!token || /[\s\p{Cc}]/u.test(token)) throw new DiscoveryError('CREDENTIALS_REQUIRED');
            const response = await this.request(url, { headers: { Accept: 'application/json', Authorization: `Bearer ${token}` },
                signal: controller.signal, redirect: 'error' });
            if (!response.ok) {
                void response.body?.cancel().catch(() => {});
                const retry = response.headers.get('retry-after');
                const milliseconds = retry && /^\d+$/u.test(retry) ? Number(retry) * 1000 : retry ? Date.parse(retry) - this.now() : 0;
                const backoff = Math.min(Number.MAX_SAFE_INTEGER - this.now(), Math.max(60000, Number.isFinite(milliseconds) ? milliseconds : 0));
                if (response.status === 429) throw new DiscoveryError('RATE_LIMITED', backoff);
                if (response.status >= 500) throw new DiscoveryError('PROVIDER_UNAVAILABLE', Math.max(300000, backoff));
                if ([401, 403].includes(response.status)) throw new DiscoveryError('PROVIDER_UNAUTHORIZED');
                throw new DiscoveryError('PROVIDER_HTTP_ERROR');
            }
            if (!response.headers.get('content-type')?.toLowerCase().includes('application/json')) {
                void response.body?.cancel().catch(() => {});
                throw new DiscoveryError('INVALID_RESPONSE');
            }
            const reader = response.body?.getReader();
            if (!reader) throw new DiscoveryError('INVALID_RESPONSE');
            const chunks: Uint8Array[] = [];
            let size = 0;
            const abortReader = () => { void reader.cancel().catch(() => {}); };
            controller.signal.addEventListener('abort', abortReader, { once: true });
            try {
                while (true) {
                    const { done, value } = await reader.read();
                    if (done) break;
                    size += value.length;
                    if (size > 1024 * 1024) throw new DiscoveryError('RESPONSE_TOO_LARGE');
                    chunks.push(value);
                }
            } finally {
                controller.signal.removeEventListener('abort', abortReader);
                void reader.cancel().catch(() => {});
                reader.releaseLock();
            }
            const bytes = Buffer.concat(chunks);
            let body: JsonRecord;
            try { body = object(JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes))); }
            catch { throw new DiscoveryError('INVALID_RESPONSE'); }
            return { body, digest: createHash('sha256').update(bytes).digest('hex') };
        };
        try { return await Promise.race([work(), timeout]); }
        catch (error) { throw error instanceof DiscoveryError ? error : new DiscoveryError('PROVIDER_NETWORK_ERROR'); }
        finally { clearTimeout(timer); controller.abort(); }
    }

    async search(query: DiscoveryQuery, beforeRequest: () => Promise<void>) {
        const first = new URL(learnApi);
        first.searchParams.set('api-version', learnVersion);
        first.searchParams.set('locale', this.config.locale);
        first.searchParams.set('maxpagesize', String(this.config.pageSize));
        if (query.products.length) first.searchParams.set('products', query.products.join(','));
        if (query.subjects.length) first.searchParams.set('subjects', query.subjects.join(','));
        let next: string | null = first.href;
        const visited = new Set<string>(), candidates: CourseCandidate[] = [];
        let rejected = 0;
        for (let page = 0; next && page < this.config.maxPages; page++) {
            const url: URL = new URL(next, learnApi);
            if (url.origin !== 'https://learn.microsoft.com' || url.pathname !== '/api/v1/modules'
                || url.username || url.password || url.hash
                || (url.searchParams.has('api-version') && url.searchParams.get('api-version') !== learnVersion)
                || visited.has(url.href)) throw new DiscoveryError('UNSAFE_PAGINATION');
            visited.add(url.href);
            const { body, digest } = await this.page(url.href, beforeRequest);
            if (!Array.isArray(body.value) || body.value.length > this.config.pageSize
                || (body.nextLink !== undefined && body.nextLink !== null && typeof body.nextLink !== 'string')) throw new DiscoveryError('INVALID_RESPONSE');
            for (const raw of body.value) {
                try {
                    const row = object(raw);
                    if (row.type !== 'module') throw new DiscoveryError('INVALID_RECORD');
                    const id = text(row.id, 512), title = text(row.title);
                    const canonicalUrl = safeCourseUrl(row.url), products = taxonomy(row.products), subjects = taxonomy(row.subjects);
                    if ((query.products.length && !query.products.some(tag => products.includes(tag)))
                        || (query.subjects.length && !query.subjects.some(tag => subjects.includes(tag)))) throw new DiscoveryError('FILTER_MISMATCH');
                    const summary = row.summary == null ? null : text(row.summary);
                    const language = row.locale == null ? null : text(row.locale, 30);
                    const levels = taxonomy(row.levels);
                    const duration = row.durationInMinutes ?? null;
                    if (duration !== null && (!Number.isInteger(duration) || Number(duration) < 0 || Number(duration) > 2147483647)) throw new DiscoveryError('INVALID_RECORD');
                    const queriedAt = new Date(this.now()).toISOString();
                    candidates.push({ source: this.name, externalId: id, title, platform: 'Microsoft Learn',
                        url: text(row.url), canonicalUrl, associatedSkills: [query.skill], queriedAt,
                        language, levels, durationMinutes: duration as number | null, isPaid: null,
                        validation: 'needs_review', reviewReasons: ['SKILL_TEACHING_NOT_VERIFIED', 'PAYMENT_UNKNOWN', 'PUBLICATION_NOT_APPROVED'],
                        evidence: [{ apiUrl: first.href, responseSha256: digest, summary, products, subjects,
                            returnedUrl: text(row.url), title, queriedAt, durationMinutes: duration as number | null, language, levels }] });
                } catch { rejected++; }
            }
            next = typeof body.nextLink === 'string' && body.nextLink ? body.nextLink : null;
        }
        return { candidates, rejected, truncated: next !== null };
    }
}
