import { createHash } from 'node:crypto';
import { parseCatalogDocument, type CatalogCourse } from '../catalog-import/document.js';

export interface Facts {
    sourceId: string; title: string; url: string; platform: string;
    availability: 'available' | 'unknown' | 'unavailable';
    language: string | null; level: string | null; durationHours: number | null; isPaid: boolean | null;
    attribution: string; metadataLicense: string;
}
export interface Check { field: keyof Facts; value: Facts[keyof Facts]; reference: string; checkedOn: string; note: string }
export interface SkillProposal {
    label: string; rationale: string; evidenceReference: string | null;
    canonicalName: string | null; decision: 'pending' | 'approved' | 'rejected';
}
export interface Review {
    reviewer: string; approvedAt: string; contentSha256: string;
    title: boolean; url: boolean; cost: boolean; skills: boolean; rights: boolean; availability: boolean;
    noSkillsReason: string | null;
}
export interface Candidate {
    facts: Facts; subjects: string[]; optionalCosts: string | null; pageLicenseNotice: string | null;
    checks: Check[]; skillProposals: SkillProposal[]; review: Review | null;
}
export interface Pilot {
    formatVersion: 1; batchId: string;
    vocabulary: { names: string[]; reference: string | null; checkedOn: string | null };
    candidates: Candidate[];
}
const factKeys = ['sourceId', 'title', 'url', 'platform', 'availability', 'language', 'level', 'durationHours', 'isPaid', 'attribution', 'metadataLicense'];
function fail(): never { throw new Error('Formato de revisión inválido.'); }
function obj(v: unknown, keys: string[]): Record<string, unknown> {
    if (!v || typeof v !== 'object' || Array.isArray(v) || Object.keys(v).length !== keys.length || keys.some(k => !Object.hasOwn(v, k))) fail();
    return v as Record<string, unknown>;
}
function str(v: unknown): asserts v is string {
    if (typeof v !== 'string' || !v || v.trim() !== v || v.length > 4096 || /[\p{Cc}\p{Cf}\p{Cs}]/u.test(v)) fail();
}
function nullable(v: unknown) { if (v !== null) str(v); }
function list(v: unknown): unknown[] { if (!Array.isArray(v) || v.length > 1000) fail(); return v; }
function names(v: unknown) { const a = list(v); a.forEach(str); if (new Set(a).size !== a.length) fail(); }
function day(v: unknown) { str(v); if (!/^\d{4}-\d{2}-\d{2}$/.test(v) || !Number.isFinite(Date.parse(v)) || new Date(v).toISOString().slice(0, 10) !== v) fail(); }
function instant(v: unknown) { str(v); if (!/^(?!0000)\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(v) || !Number.isFinite(Date.parse(v)) || new Date(v).toISOString() !== v) fail(); }
function factType(k: string, v: unknown) {
    if (k === 'isPaid') { if (v !== null && typeof v !== 'boolean') fail(); }
    else if (k === 'durationHours') { if (v !== null && (typeof v !== 'number' || !Number.isFinite(v) || v < 0)) fail(); }
    else if (k === 'language' || k === 'level') nullable(v);
    else if (k === 'availability') { if (!['available', 'unknown', 'unavailable'].includes(v as string)) fail(); }
    else str(v);
}
export function parsePilot(value: unknown): Pilot {
    const p = obj(value, ['formatVersion', 'batchId', 'vocabulary', 'candidates']);
    if (p.formatVersion !== 1) fail(); str(p.batchId);
    const v = obj(p.vocabulary, ['names', 'reference', 'checkedOn']); names(v.names); nullable(v.reference);
    if (v.checkedOn !== null) day(v.checkedOn);
    const candidates = list(p.candidates); if (!candidates.length || candidates.length > 10) fail();
    for (const raw of candidates) {
        const c = obj(raw, ['facts', 'subjects', 'optionalCosts', 'pageLicenseNotice', 'checks', 'skillProposals', 'review']);
        const f = obj(c.facts, factKeys); for (const k of factKeys) factType(k, f[k]);
        names(c.subjects); nullable(c.optionalCosts); nullable(c.pageLicenseNotice);
        for (const rawCheck of list(c.checks)) {
            const e = obj(rawCheck, ['field', 'value', 'reference', 'checkedOn', 'note']);
            if (!factKeys.includes(e.field as string)) fail(); factType(e.field as string, e.value);
            str(e.reference); day(e.checkedOn); str(e.note);
        }
        for (const rawSkill of list(c.skillProposals)) {
            const s = obj(rawSkill, ['label', 'rationale', 'evidenceReference', 'canonicalName', 'decision']);
            str(s.label); str(s.rationale); nullable(s.evidenceReference); nullable(s.canonicalName);
            if (!['pending', 'approved', 'rejected'].includes(s.decision as string)) fail();
        }
        if (c.review !== null) {
            const r = obj(c.review, ['reviewer', 'approvedAt', 'contentSha256', 'title', 'url', 'cost', 'skills', 'rights', 'availability', 'noSkillsReason']);
            str(r.reviewer); instant(r.approvedAt); str(r.contentSha256); nullable(r.noSkillsReason);
            for (const k of ['title', 'url', 'cost', 'skills', 'rights', 'availability']) if (typeof r[k] !== 'boolean') fail();
        }
    }
    return value as Pilot;
}
// Sorted object keys, preserved arrays and exact skill names. No clock, network or DB.
function canonical(v: unknown): string {
    if (Array.isArray(v)) return '[' + v.map(canonical).join(',') + ']';
    if (v && typeof v === 'object') return '{' + Object.entries(v).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0).map(([k, x]) => JSON.stringify(k) + ':' + canonical(x)).join(',') + '}';
    return JSON.stringify(v);
}
export function contentHash(c: Candidate, vocabulary: Pilot['vocabulary']): string {
    const { review: _review, ...content } = c;
    return createHash('sha256').update(canonical({ content, vocabulary })).digest('hex');
}
function sorted(values: string[]) { return [...values].sort(); }
function reference(c: Candidate, hash: string) {
    return [c.facts.attribution, c.facts.metadataLicense, 'OpenLearn ID ' + c.facts.sourceId,
        ...sorted([...new Set(c.checks.map(e => e.checkedOn + ' ' + e.reference))]),
        ...sorted([...new Set(c.skillProposals.filter(s => s.decision === 'approved').map(s => s.evidenceReference!))]),
        'review ' + c.review!.reviewer + ' ' + c.review!.approvedAt, 'sha256 ' + hash].join(' | ');
}
export function preparePilot(value: unknown) {
    const p = parsePilot(value);
    const rows = p.candidates.map(c => {
        const f = c.facts, blockers: string[] = [], hash = contentHash(c, p.vocabulary);
        const block = (s: string) => { if (!blockers.includes(s)) blockers.push(s); };
        if (p.candidates.filter(x => x.facts.sourceId === f.sourceId).length > 1) block('DUPLICATE_SOURCE_ID');
        if (p.candidates.filter(x => x.facts.url === f.url).length > 1) block('DUPLICATE_URL');
        if (!/^https:\/\/www\.open\.edu\/openlearn\/[a-z0-9-]+(?:\/[a-z0-9-]+)*\/content-section-0$/.test(f.url)) block('DIRECT_URL_REQUIRED');
        if (f.availability !== 'available') block('AVAILABILITY_UNVERIFIED');
        if (f.isPaid === null) block('ACCESS_COST_UNKNOWN');
        if (f.durationHours !== null && (!Number.isInteger(f.durationHours) || f.durationHours > 2147483647)) block('DURATION_NOT_REPRESENTABLE_IN_V1');
        for (const field of factKeys as (keyof Facts)[]) {
            const checks = c.checks.filter(e => e.field === field);
            if (f[field] !== null && !checks.some(e => e.value === f[field])) block('EVIDENCE_MISSING:' + field);
            if (checks.some(e => e.value !== f[field])) block('CONTRADICTORY_METADATA:' + field);
        }
        const accepted = c.skillProposals.filter(s => s.decision === 'approved');
        if (c.skillProposals.some(s => s.decision === 'pending')) block('SKILLS_PENDING');
        if (accepted.some(s => !s.evidenceReference)) block('SKILL_EVIDENCE_MISSING');
        if (accepted.some(s => s.canonicalName === null || !p.vocabulary.names.includes(s.canonicalName))) block('EXACT_SKILL_MATCH_REQUIRED');
        if (accepted.length && (!p.vocabulary.reference || !p.vocabulary.checkedOn)) block('VOCABULARY_UNVERIFIED');
        const skills = accepted.map(s => s.canonicalName!);
        if (new Set(skills).size !== skills.length) block('DUPLICATE_SKILL');
        if (!c.review) block('EXPLICIT_REVIEW_REQUIRED');
        else {
            if (c.review.contentSha256 !== hash) block('REVIEW_CONTENT_CHANGED');
            for (const k of ['title', 'url', 'cost', 'skills', 'rights', 'availability'] as const) if (!c.review[k]) block('APPROVAL_REQUIRED:' + k);
            if (!skills.length && !c.review.noSkillsReason) block('NO_SKILLS_JUSTIFICATION_REQUIRED');
            if (c.checks.some(e => e.checkedOn > c.review!.approvedAt.slice(0, 10)) || (p.vocabulary.checkedOn && p.vocabulary.checkedOn > c.review.approvedAt.slice(0, 10))) block('REVIEW_PREDATES_EVIDENCE');
        }
        let course: CatalogCourse | null = null;
        if (!blockers.length) {
            const proposed = { title: f.title, platform: f.platform, url: f.url, isPaid: f.isPaid!, durationHours: f.durationHours,
                logoUrl: null, skills: sorted(skills), sourceReference: reference(c, hash) };
            try { course = parseCatalogDocument({ formatVersion: 1, batchId: p.batchId, reviewedAt: c.review!.approvedAt, skills: [], courses: [proposed] }).courses[0]!; }
            catch { block('CATALOG_V1_INCOMPATIBLE'); }
        }
        return { sourceId: f.sourceId, contentSha256: hash, status: blockers.length ? 'blocked' : 'reviewed', blockers, candidate: c, course };
    }).sort((a, b) => a.sourceId < b.sourceId ? -1 : a.sourceId > b.sourceId ? 1 : 0);
    const eligible = rows.filter(r => r.course !== null);
    const catalog = eligible.length ? parseCatalogDocument({ formatVersion: 1, batchId: p.batchId,
        reviewedAt: sorted(eligible.map(r => r.candidate.review!.approvedAt)).at(-1),
        skills: [], // Only exact matches from a reviewed vocabulary. Never create inferred skills.
        courses: eligible.map(r => r.course) }) : null;
    return { formatVersion: 1, batchId: p.batchId, authorizedToPublish: false, vocabulary: p.vocabulary, rows, catalog };
}
