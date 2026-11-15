import { text, skillKey } from '../course-discovery/model.js';
import type { SyncCandidate } from './model.js';

export function timestamp(value: unknown): string {
    const raw = text(value);
    if (!/^(?!0000)\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/.test(raw)
        || !Number.isFinite(Date.parse(raw)) || new Date(raw).toISOString() !== raw) throw new Error('INVALID_DATE');
    return raw;
}
// Conservative canonicalization, no network access. Query/path/locale remain significant.
// Real adapters must additionally enforce their own approved host and path allowlists.
export function canonicalUrl(value: unknown): string {
    const raw = text(value), decoded = decodeURIComponent(raw), url = new URL(raw);
    if (!/^https:\/\/[^/?#@]+(?:\/|$)/u.test(raw) || /[\s\\#]/u.test(raw)
        || /[\p{Cc}\p{Cf}\p{Cs}\s]/u.test(decoded) || url.username || url.password || url.hash
        || !url.hostname || url.port || /\/(?:\.|\.\.)(?:\/|$)/u.test(decoded)) throw new Error('INVALID_URL');
    return url.href;
}
const available = (v: unknown) => typeof v === 'string' && ['available', 'unavailable', 'withdrawn', 'unknown'].includes(v);
function validateLocation(modality: unknown, geography: SyncCandidate['geography']) {
    if (!['virtual', 'presential', 'hybrid', 'unknown'].includes(String(modality)) || typeof modality !== 'string') throw new Error('INVALID_MODALITY');
    if (geography !== null) {
        if (!geography || typeof geography !== 'object' || Array.isArray(geography)) throw new Error('INVALID_GEOGRAPHY');
        for (const k of ['country', 'region', 'locality'] as const) if (geography[k] !== null) text(geography[k], 200);
    }
}
export function normalize(value: unknown, sourceId: string, observedAt: string): SyncCandidate {
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('INVALID_RECORD');
    const c = structuredClone(value) as SyncCandidate;
    if (text(c.sourceId) !== sourceId) throw new Error('SOURCE_MISMATCH');
    if (c.externalId !== null) text(c.externalId, 512);
    text(c.title); text(c.platform);
    c.canonicalUrl = canonicalUrl(c.canonicalUrl);
    if (timestamp(c.lastSeenAt) > observedAt) throw new Error('FUTURE_OBSERVATION');
    if (c.language !== null) text(c.language, 100);
    if (c.isPaid !== null && typeof c.isPaid !== 'boolean') throw new Error('INVALID_PRICE');
    if (c.durationMinutes !== null && (!Number.isSafeInteger(c.durationMinutes) || c.durationMinutes <= 0)) throw new Error('INVALID_DURATION');
    if (!Array.isArray(c.associatedSkills) || c.associatedSkills.length > 1000) throw new Error('INVALID_SKILLS');
    const skills = new Map<string, string>();
    for (const s of c.associatedSkills) {
        text(s, 200); const key = skillKey(s);
        if (skills.has(key) && skills.get(key) !== s) throw new Error('AMBIGUOUS_SKILL');
        skills.set(key, s);
    }
    c.associatedSkills = [...skills.values()].sort();
    if (!available(c.availability)
        || !['needs_review', 'conflict'].includes(c.validation)) throw new Error('INVALID_STATE');
    validateLocation(c.modality, c.geography);
    if (!Array.isArray(c.evidence) || !c.evidence.length) throw new Error('MISSING_EVIDENCE');
    for (const e of c.evidence) {
        canonicalUrl(e.apiUrl); canonicalUrl(e.returnedUrl); text(e.title);
        if (timestamp(e.queriedAt) !== c.lastSeenAt) throw new Error('STALE_EVIDENCE');
        if (!/^[a-f0-9]{64}$/u.test(e.responseSha256)) throw new Error('INVALID_EVIDENCE');
    }
    if (!Array.isArray(c.offerings)) throw new Error('INVALID_OFFERINGS');
    const ids = new Set<string>();
    for (const o of c.offerings) {
        text(o.externalId); if (ids.has(o.externalId) || !available(o.availability)) throw new Error('INVALID_OFFERING');
        validateLocation(o.modality, o.geography);
        ids.add(o.externalId);
        if (o.startsAt !== null) timestamp(o.startsAt);
        if (o.endsAt !== null) timestamp(o.endsAt);
        if (o.startsAt && o.endsAt && o.startsAt > o.endsAt) throw new Error('INVALID_OFFERING_DATES');
    }
    c.offerings.sort((a, b) => a.externalId < b.externalId ? -1 : a.externalId > b.externalId ? 1 : 0);
    return c;
}
export function identity(c: SyncCandidate): string {
    return JSON.stringify([c.sourceId, c.externalId === null ? 'url' : 'id', c.externalId ?? c.canonicalUrl]);
}
export function metadata(c: SyncCandidate): string {
    return JSON.stringify([c.title, c.platform, c.canonicalUrl, c.associatedSkills, c.language, c.durationMinutes,
        c.isPaid, c.modality, c.geography && [c.geography.country, c.geography.region, c.geography.locality],
        c.availability, c.offerings.map(o => [o.externalId, o.availability, o.startsAt, o.endsAt,
            o.modality, o.geography && [o.geography.country, o.geography.region, o.geography.locality]]), c.validation]);
}
