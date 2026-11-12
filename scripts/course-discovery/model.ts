import { normalizeJobSkillName } from '../../src/domain/job-skills-gap.js';
import { parseCatalogDocument, type CatalogDocument } from '../catalog-import/document.js';

export class DiscoveryError extends Error {
    constructor(public readonly code: string, public readonly retryAfterMs = 0) { super(code); }
}
export interface DiscoveryQuery { skill: string; products: string[]; subjects: string[] }
export interface DiscoveryConfig {
    enabled: boolean; locale: string; intervalHours: number; cacheHours: number;
    timeoutMs: number; maxRequestsPerRun: number; maxRequestsPerDay: number;
    minRequestIntervalMs: number; maxPages: number; pageSize: number; queries: DiscoveryQuery[];
}
export interface CourseCandidate {
    source: string; externalId: string | null; title: string; platform: string;
    url: string; canonicalUrl: string; associatedSkills: string[]; queriedAt: string;
    language: string | null; levels: string[]; durationMinutes: number | null; isPaid: boolean | null;
    validation: 'needs_review' | 'conflict'; reviewReasons: string[];
    evidence: { apiUrl: string; responseSha256: string; summary: string | null;
        products: string[]; subjects: string[]; returnedUrl: string; title: string;
        queriedAt: string; durationMinutes: number | null; language: string | null; levels: string[] }[];
}
export interface DiscoveryPageResult { candidates: CourseCandidate[]; rejected: number; truncated: boolean }
export interface CourseDiscoveryProvider {
    readonly name: string;
    search(query: DiscoveryQuery, beforeRequest: () => Promise<void>): Promise<DiscoveryPageResult>;
}

export function text(value: unknown, max = 4096): string {
    if (typeof value !== 'string' || !value.trim() || value !== value.trim() || value.length > max
        || /[\p{Cc}\p{Cf}\p{Cs}]/u.test(value)) throw new DiscoveryError('INVALID_INPUT');
    return value;
}
export function skillKey(value: string): string { return normalizeJobSkillName(value).key; }

// No se elimina query, fragmento, locale ni barra final para forzar una coincidencia.
// Solo se aceptan enlaces directos de módulos oficiales; nunca se descargan esas páginas.
export function safeCourseUrl(value: unknown): string {
    const raw = text(value);
    let parsed: URL;
    try { parsed = new URL(raw); } catch { throw new DiscoveryError('UNSAFE_URL'); }
    if (!raw.startsWith('https://') || !/^https:\/\/learn\.microsoft\.com(?::443)?\//iu.test(raw)
        || /[\s\\%?#]/u.test(raw) || /\/\/(?:[^/?#]*@)/u.test(raw)
        || parsed.hostname !== 'learn.microsoft.com' || parsed.port || parsed.username || parsed.password
        || parsed.search || parsed.hash || /\/(?:\.|\.\.)(?:\/|$)/u.test(raw)
        || !/^\/(?:[a-z]{2}(?:-[a-z]{2})?\/)?training\/modules\/[a-z0-9-]+\/?$/u.test(parsed.pathname)) {
        throw new DiscoveryError('UNSAFE_URL');
    }
    return parsed.href;
}

export function parseDiscoveryConfig(value: unknown): DiscoveryConfig {
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw new DiscoveryError('INVALID_CONFIG');
    const input = value as Record<string, unknown>;
    const defaults = { enabled: false, locale: 'en-us', intervalHours: 24, cacheHours: 6,
        timeoutMs: 10000, maxRequestsPerRun: 10, maxRequestsPerDay: 30,
        minRequestIntervalMs: 2000, maxPages: 2, pageSize: 20 };
    if (Object.keys(input).some(key => ![...Object.keys(defaults), 'queries'].includes(key))) throw new DiscoveryError('INVALID_CONFIG');
    const config = { ...defaults, ...input } as unknown as DiscoveryConfig;
    if (typeof config.enabled !== 'boolean' || typeof config.locale !== 'string'
        || !/^[a-z]{2}-[a-z]{2}$/u.test(config.locale)) throw new DiscoveryError('INVALID_CONFIG');
    const bounds = { intervalHours: [1, 168], cacheHours: [1, 24], timeoutMs: [10, 30000],
        maxRequestsPerRun: [1, 30], maxRequestsPerDay: [1, 100], minRequestIntervalMs: [2000, 60000],
        maxPages: [1, 5], pageSize: [1, 100] };
    for (const [key, [min, max]] of Object.entries(bounds)) {
        const number = config[key as keyof typeof bounds];
        if (!Number.isInteger(number) || number < min! || number > max!) throw new DiscoveryError('INVALID_CONFIG');
    }
    if (!Array.isArray(config.queries) || !config.queries.length || config.queries.length > 20) throw new DiscoveryError('INVALID_CONFIG');
    const seen = new Set<string>();
    config.queries = config.queries.map(raw => {
        if (!raw || typeof raw !== 'object' || Array.isArray(raw)
            || Object.keys(raw).some(key => !['skill', 'products', 'subjects'].includes(key))) throw new DiscoveryError('INVALID_CONFIG');
        const skill = text(raw.skill, 200);
        // Reutiliza las reglas administrativas de nombres sin cambiar su escritura canónica.
        parseCatalogDocument({ formatVersion: 1, batchId: 'discovery-config', reviewedAt: '2026-01-01T00:00:00.000Z', skills: [skill], courses: [] });
        const key = skillKey(skill);
        if (seen.has(key)) throw new DiscoveryError('AMBIGUOUS_SKILL');
        seen.add(key);
        const tags = (value: unknown): string[] => {
            if (value === undefined) return [];
            if (!Array.isArray(value) || value.length > 10) throw new DiscoveryError('INVALID_CONFIG');
            const result = value.map(tag => text(tag, 100));
            if (result.some(tag => !/^[a-z0-9][a-z0-9.-]*$/u.test(tag)) || new Set(result).size !== result.length) throw new DiscoveryError('INVALID_CONFIG');
            return result;
        };
        const products = tags(raw.products), subjects = tags(raw.subjects);
        if (!products.length && !subjects.length) throw new DiscoveryError('MISSING_SKILL_FILTER');
        return { skill, products, subjects };
    });
    return config;
}

export function consolidateCandidates(input: CourseCandidate[], catalog?: CatalogDocument): CourseCandidate[] {
    const groups: CourseCandidate[][] = [];
    for (const candidate of input) {
        const related = groups.filter(group => group.some(item => item.canonicalUrl === candidate.canonicalUrl
            || (item.source === candidate.source && item.externalId !== null && item.externalId === candidate.externalId)));
        const combined = [...related.flat(), candidate];
        for (const group of related) groups.splice(groups.indexOf(group), 1);
        groups.push(combined);
    }
    return groups.map(group => {
        const first = group[0]!;
        const fingerprint = (c: CourseCandidate) => JSON.stringify([c.title, c.platform, c.canonicalUrl,
            c.language, c.levels, c.durationMinutes, c.isPaid]);
        const conflict = group.some(c => fingerprint(c) !== fingerprint(first));
        const existing = catalog?.courses.some(c => {
            try { return group.some(item => safeCourseUrl(c.url) === item.canonicalUrl); }
            catch { return false; }
        }) ?? false;
        return { ...first, associatedSkills: [...new Set(group.flatMap(c => c.associatedSkills))].sort(),
            evidence: [...new Map(group.flatMap(c => c.evidence).map(e => [JSON.stringify(e), e])).values()],
            validation: conflict || existing ? 'conflict' as const : 'needs_review' as const,
            reviewReasons: [...new Set([...group.flatMap(c => c.reviewReasons),
                ...(conflict ? ['SOURCE_METADATA_CONFLICT'] : []), ...(existing ? ['EXISTING_CATALOG_URL_REVIEW'] : [])])] };
    }).sort((a, b) => a.canonicalUrl < b.canonicalUrl ? -1 : a.canonicalUrl > b.canonicalUrl ? 1 : 0);
}
