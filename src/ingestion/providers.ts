import { createHash } from 'node:crypto';

export const vocabulary = ['Python','JavaScript','SQL','Git','Docker','Ciberseguridad','HTML','CSS'] as const;
export type Skill = typeof vocabulary[number];
export type Provider = 'openlearn' | 'freecodecamp';
export interface AutomaticCourse {
    title: string; platform: string; url: string; durationHours: number | null; isPaid: false; skills: Skill[];
    evidence: { source: string; sha256: string; fields: string[] }[];
}
export interface Discovery {
    provider: Provider; found: number; courses: AutomaticCourse[]; rejected: { url: string | null; reason: string }[];
    sources: { url: string; sha256: string }[];
}
export class IngestError extends Error {
    constructor(public readonly code: string, public readonly retryAfterMs = 0) { super(code); }
}
export const digest = (value: string) => createHash('sha256').update(value).digest('hex');
export const openLearnQuery = `SELECT DISTINCT ?resource ?title ?url ?description
FROM <http://data.open.ac.uk/context/openlearn2> WHERE {
 ?resource a <http://data.open.ac.uk/openlearn/ontology/OpenCourseware> ;
   <http://purl.org/dc/terms/title> ?title ; <http://dbpedia.org/property/url> ?url ;
   <http://purl.org/dc/terms/description> ?description .
 FILTER(REGEX(STR(?url), "^https?://www[.]open[.]edu/openlearn/"))
 FILTER(REGEX(STR(?description), "(^|[^a-z])(python|javascript|sql|git|docker|network security|information security|cyber security)([^a-z]|$)", "i"))
 FILTER NOT EXISTS { ?resource <http://purl.org/dc/terms/title> ?otherTitle FILTER(?title != ?otherTitle) }
 FILTER NOT EXISTS { ?resource <http://dbpedia.org/property/url> ?otherUrl FILTER(?url != ?otherUrl) }
 FILTER NOT EXISTS { ?resource <http://purl.org/dc/terms/description> ?otherDescription FILTER(?description != ?otherDescription) }
} ORDER BY STR(?resource) LIMIT 10`;
export const openLearnUrl = new URL('https://data.open.ac.uk/sparql'); openLearnUrl.searchParams.set('query',openLearnQuery);
export const fccRef = 'https://api.github.com/repos/freeCodeCamp/freeCodeCamp/git/ref/heads/main';
const fccPaths = ['python-v9','javascript-v9','relational-databases-v9','responsive-web-design-v9'];
const fccSkills: Record<string,Skill[]> = { 'python-v9': ['Python'],'javascript-v9': ['JavaScript'],
    'relational-databases-v9': ['SQL','Git'],'responsive-web-design-v9': ['HTML','CSS'] };
// Connector URL policy checked against the official descriptive pages on 2026-11-16.
// RDF contains historical links (including a now-404 Network security path).
// These are explicit verified aliases, never a general HTTP upgrade or inferred redirect.
const openLearnAliases: Record<string,{ title: string; url: string }> = {
    'http://www.open.edu/openlearn/science-maths-technology/computing-and-ict/systems-computer/network-security/content-section-0': {
        title: 'Network security',url: 'https://www.open.edu/openlearn/digital-computing/network-security/content-section-0' },
    'http://www.open.edu/openlearn/science-maths-technology/information-security/content-section-0': {
        title: 'Information security',url: 'https://www.open.edu/openlearn/science-maths-technology/information-security/content-section-0' },
};
const terms: Record<Skill, RegExp> = { Python: /\bPython\b/i,JavaScript: /\bJavaScript\b/i,SQL: /\bSQL\b/i,Git: /\bGit\b/i,
    Docker: /\bDocker\b/i,Ciberseguridad: /\b(?:network security|information security|cyber security|cybersecurity)\b/i,
    HTML: /\bHTML\b/i,CSS: /\bCSS\b/i };
function skills(paragraphs: string[]): Skill[] {
    // An explicit teaching/learning statement and exact technology in that paragraph.
    // Neither titles, generic categories nor "Java" imply JavaScript.
    return vocabulary.filter(skill => paragraphs.some(p => p.length <= 1500 && terms[skill].test(p)
        && /\b(?:teach(?:es|ing)?|learn(?:ing)?|stud(?:y|ying)|explain(?:s|ing)?|cover(?:s|ing)?|discuss(?:es|ing)?)\b/i.test(p)
        && !/\b(?:not teach|not learn|does not cover|must already know|prerequisite)\b/i.test(p)));
}
function text(v: unknown, max = 4096): string {
    if (typeof v !== 'string' || !v.trim() || v.length > max || /[\p{Cc}\p{Cf}\p{Cs}]/u.test(v)) throw new IngestError('INVALID_METADATA');
    return v.trim();
}
export function officialCourseUrl(v: unknown, provider: Provider): string {
    const s = text(v,2000), u = new URL(s);
    if (u.username || u.password || u.port || u.search || u.hash || /[\\%\s]/.test(s)) throw new IngestError('UNSAFE_COURSE_URL');
    if (provider === 'openlearn' ? !/^https?:\/\/www\.open\.edu\/openlearn\/[a-z0-9-]+(?:\/[a-z0-9-]+)*\/content-section-0$/.test(s)
        : !/^https:\/\/www\.freecodecamp\.org\/learn\/[a-z0-9-]+\/$/.test(s)) throw new IngestError('UNSAFE_COURSE_URL');
    return s; // Preserve legacy official HTTP links from RDF; never fabricate a redirect or RDF identity.
}
async function download(url: string, request: typeof fetch, kind: 'json' | 'text') {
    if (!['data.open.ac.uk','api.github.com','raw.githubusercontent.com'].includes(new URL(url).hostname)) throw new IngestError('UNSAFE_SOURCE');
    const response = await request(url,{ redirect: 'error',credentials: 'omit',signal: AbortSignal.timeout(15000),
        headers: { Accept: kind === 'json' ? 'application/json, application/sparql-results+json' : 'text/plain',
            'User-Agent': 'CVExpert-CourseCatalog/1.0 (bounded public metadata)' } });
    if (response.redirected || response.url && response.url !== url) throw new IngestError('UNSAFE_REDIRECT');
    if (!response.ok) {
        const value = response.headers.get('retry-after');
        const delay = value && /^\d+$/.test(value) ? Number(value) * 1000 : value ? Date.parse(value) - Date.now() : 0;
        const retryAfterMs = Number.isFinite(delay) && delay >= 0 ? Math.min(Number.MAX_SAFE_INTEGER,delay) : 86400000;
        await response.body?.cancel().catch(() => {});
        throw new IngestError(response.status === 429 ? 'PROVIDER_RATE_LIMITED' : `PROVIDER_HTTP_${response.status}`,
            response.status === 429 ? Math.max(3600000,retryAfterMs) : retryAfterMs);
    }
    if (response.headers.has('x-sparql-maxrows')) throw new IngestError('TRUNCATED_RESPONSE');
    if (!/^(?:application\/(?:json|sparql-results\+json)|text\/plain)(?:;|$)/i.test(response.headers.get('content-type') ?? '')) throw new IngestError('UNEXPECTED_CONTENT_TYPE');
    const reader = response.body?.getReader(); if (!reader) throw new IngestError('EMPTY_RESPONSE');
    const chunks: Uint8Array[] = []; let bytes = 0;
    try {
        while (true) { const part = await reader.read(); if (part.done) break;
            bytes += part.value.byteLength; if (bytes > 1024 * 1024) throw new IngestError('RESPONSE_TOO_LARGE'); chunks.push(part.value); }
    } finally { await reader.cancel().catch(() => {}); reader.releaseLock(); }
    const body = new TextDecoder('utf-8',{ fatal: true }).decode(Buffer.concat(chunks));
    return { body,sha256: digest(body),url };
}
function finish(result: Discovery) {
    const grouped = new Map<string,AutomaticCourse[]>();
    result.courses.forEach(c => grouped.set(c.url,[...(grouped.get(c.url) ?? []),c]));
    result.courses = [];
    for (const [url,group] of grouped) {
        if (group.some(c => JSON.stringify(c) !== JSON.stringify(group[0]))) result.rejected.push({ url,reason: 'CONTRADICTORY_METADATA' });
        else result.courses.push(group[0]!);
    }
    return result;
}
export async function discoverOpenLearn(request: typeof fetch = fetch): Promise<Discovery> {
    const source = await download(openLearnUrl.href,request,'json'), data = JSON.parse(source.body);
    if (!Array.isArray(data.head?.vars) || data.head.vars.length !== 4 || !['resource','title','url','description'].every(v => data.head.vars.includes(v))
        || !Array.isArray(data.results?.bindings) || data.results.bindings.length > 10
        || data.meta?.['result-size-total'] !== undefined && data.meta['result-size-total'] !== data.results.bindings.length) throw new IngestError('INVALID_SPARQL_RESPONSE');
    const result: Discovery = { provider: 'openlearn',found: data.results.bindings.length,courses: [],rejected: [],sources: [{ url: source.url,sha256: source.sha256 }] };
    for (const row of data.results.bindings) {
        let returnedUrl: string | null = null;
        try {
            if (row.resource?.type !== 'uri' || !/^http:\/\/data\.open\.ac\.uk\/openlearn\/[a-z0-9/-]+\/content-section-0$/.test(text(row.resource?.value))
                || row.url?.type !== 'uri' || row.title?.type !== 'literal' || row.description?.type !== 'literal') throw new IngestError('INVALID_RDF_TERMS');
            let url = officialCourseUrl(row.url.value,'openlearn');
            returnedUrl = url;
            const title = text(row.title.value), description = text(row.description.value);
            const alias = openLearnAliases[url.replace(/^https:/,'http:')];
            if (alias) {
                if (title !== alias.title) throw new IngestError('CANONICAL_ALIAS_IDENTITY_MISMATCH');
                url = alias.url;
            } else if (!url.startsWith('https://')) throw new IngestError('OFFICIAL_HTTPS_ROUTE_NOT_VERIFIED');
            if (!/\b(?:this|the) free course\b/i.test(description) || /\b(?:not free|no longer free|paid course|payment required)\b/i.test(description)) throw new IngestError('FREE_ACCESS_NOT_VERIFIED');
            const associated = skills([description]); if (!associated.length) throw new IngestError('NO_SUPPORTED_SKILL_EVIDENCE');
            result.courses.push({ title,platform: 'OpenLearn — The Open University',url,durationHours: null,isPaid: false,skills: associated,
                evidence: [{ source: source.url,sha256: source.sha256,fields: [row.resource.value,'dct:description:free course',
                    ...(alias ? ['verified canonical alias policy 2026-11-16',alias.url] : []),...associated.map(s => `dct:description:${s}`)] }] });
        } catch (e) { result.rejected.push({ url: returnedUrl,reason: e instanceof IngestError ? e.code : 'INVALID_METADATA' }); }
    }
    return finish(result);
}
export async function discoverFreeCodeCamp(request: typeof fetch = fetch): Promise<Discovery> {
    const ref = await download(fccRef,request,'json'), sha = JSON.parse(ref.body).object?.sha;
    if (typeof sha !== 'string' || !/^[a-f0-9]{40}$/.test(sha)) throw new IngestError('INVALID_CURRICULUM_COMMIT');
    const base = `https://raw.githubusercontent.com/freeCodeCamp/freeCodeCamp/${sha}/`;
    const readme = await download(base + 'README.md',request,'text');
    const intro = await download(base + 'client/i18n/locales/english/intro.json',request,'json');
    const data = JSON.parse(intro.body);
    if (!/^freeCodeCamp\.org offers several free developer certifications that make up /im.test(readme.body)) throw new IngestError('FREE_ACCESS_NOT_VERIFIED');
    const published = new Set([...readme.body.matchAll(/\]\(https:\/\/www\.freecodecamp\.org\/learn\/([a-z0-9-]+)\/\)/g)].map(m => m[1]));
    const result: Discovery = { provider: 'freecodecamp',found: 0,courses: [],rejected: [],sources: [ref,readme,intro].map(s => ({ url: s.url,sha256: s.sha256 })) };
    for (const slug of fccPaths.filter(k => published.has(k))) {
        result.found++;
        try {
            const entry = data[slug]; if (!entry || !Array.isArray(entry.intro) || !entry.intro.every((p: unknown) => typeof p === 'string')) throw new IngestError('INVALID_CURRICULUM_METADATA');
            if (entry.intro.some((p: string) => /\b(?:not free|no longer free|payment required|subscription required)\b/i.test(p))) throw new IngestError('FREE_ACCESS_NOT_VERIFIED');
            const paragraphs: string[] = [...entry.intro], paths = entry.intro.map((_: string,i: number) => `${slug}.intro[${i}]`);
            // Block introductions are metadata, not lessons/challenge solutions.
            for (const [key,block] of Object.entries(entry.blocks ?? {}) as [string,{ intro?: unknown }][]) if (Array.isArray(block.intro)) {
                block.intro.forEach((p,i) => { if (typeof p === 'string') { paragraphs.push(p); paths.push(`${slug}.blocks.${key}.intro[${i}]`); } });
            }
            const associated = skills(paragraphs).filter(s => fccSkills[slug]!.includes(s));
            if (!associated.length) throw new IngestError('NO_SUPPORTED_SKILL_EVIDENCE');
            result.courses.push({ title: text(entry.title),platform: 'freeCodeCamp',url: officialCourseUrl(`https://www.freecodecamp.org/learn/${slug}/`,'freecodecamp'),
                durationHours: null,isPaid: false,skills: associated,evidence: [
                    { source: intro.url,sha256: intro.sha256,fields: associated.map(s => `${paths[paragraphs.findIndex(p => skills([p]).includes(s))]} -> ${s}`) },
                    { source: readme.url,sha256: readme.sha256,fields: ['free developer certifications','published curriculum link'] }] });
        } catch (e) { result.rejected.push({ url: `https://www.freecodecamp.org/learn/${slug}/`,reason: e instanceof IngestError ? e.code : 'INVALID_METADATA' }); }
    }
    if (!result.found) throw new IngestError('NO_PUBLISHED_CURRICULUM');
    return finish(result);
}
