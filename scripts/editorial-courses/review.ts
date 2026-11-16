import { createHash } from 'node:crypto';
import { text } from '../course-discovery/model.js';
import { parseCatalogDocument, type CatalogCourse } from '../catalog-import/document.js';

export interface OfficialCandidate {
    url: string; aliases: string[]; title: string; platform: string;
    availability: 'page_accessible' | 'unknown'; isPaid: boolean | null; optionalCosts: string | null;
    durationHours: number | null; providerLevel: string | null; language: string | null;
    learningOutcomes: string[]; skillProposals: { label: string; rationale: string }[];
    evidenceSections: string[]; operationalWarnings: string[]; rdfIdentity: null; editorialStatus: 'pending';
}
export interface OfficialRegistry {
    formatVersion: 1; batchId: string; sourceKind: 'editorial_official_page_url'; checkedOn: string;
    attribution: string; rightsReference: string; rightsStatus: 'pending_human_review'; candidates: OfficialCandidate[];
}
const checks = ['title','url','cost','availability','rights','warnings'] as const;
export interface EditorialReview {
    formatVersion: 1; purpose: 'editorial_review' | 'TEST_ONLY'; reviewer: string | null;
    reviewedAt: string | null; contentSha256: string | null;
    vocabulary: { names: string[]; reference: string | null; checkedOn: string | null };
    decisions: { url: string; decision: 'pending' | 'approved' | 'rejected';
        associations: { proposal: string; canonicalName: string; rationale: string }[];
        confirmations: Record<typeof checks[number],boolean>; noSkillsReason: string | null; note: string | null }[];
}
function object(v: unknown, fields: string[]): asserts v is Record<string,unknown> {
    if (!v || typeof v !== 'object' || Array.isArray(v) || Object.keys(v).length !== fields.length
        || fields.some(k => !Object.hasOwn(v,k))) throw new Error('INVALID_EDITORIAL_SCHEMA');
}
function list(v: unknown): asserts v is unknown[] { if (!Array.isArray(v) || v.length > 1000) throw new Error('INVALID_LIST'); }
function names(v: unknown): asserts v is string[] { list(v); v.forEach(s => text(s)); if (new Set(v).size !== v.length) throw new Error('DUPLICATE_VALUE'); }
function nullable(v: unknown) { if (v !== null) text(v); }
function day(v: unknown) { text(v); if (!/^\d{4}-\d{2}-\d{2}$/.test(v as string) || new Date(v as string).toISOString().slice(0,10) !== v) throw new Error('INVALID_DAY'); }
function officialUrl(v: unknown) {
    text(v);
    if (!/^https:\/\/www\.open\.edu\/openlearn\/[a-z0-9-]+(?:\/[a-z0-9-]+)*\/?$/.test(v as string)) throw new Error('OFFICIAL_URL_REQUIRED');
}
export function parseOfficialRegistry(value: unknown): OfficialRegistry {
    object(value,['formatVersion','batchId','sourceKind','checkedOn','attribution','rightsReference','rightsStatus','candidates']);
    if (value.formatVersion !== 1 || value.sourceKind !== 'editorial_official_page_url' || value.rightsStatus !== 'pending_human_review') throw new Error('INVALID_ORIGIN');
    text(value.batchId); day(value.checkedOn); text(value.attribution); text(value.rightsReference); list(value.candidates);
    if (!value.candidates.length || value.candidates.length > 10) throw new Error('INVALID_CANDIDATE_COUNT');
    for (const c of value.candidates) {
        object(c,['url','aliases','title','platform','availability','isPaid','optionalCosts','durationHours','providerLevel','language',
            'learningOutcomes','skillProposals','evidenceSections','operationalWarnings','rdfIdentity','editorialStatus']);
        officialUrl(c.url); names(c.aliases); c.aliases.forEach(officialUrl); text(c.title); text(c.platform);
        if (!['page_accessible','unknown'].includes(c.availability as string) || c.rdfIdentity !== null || c.editorialStatus !== 'pending'
            || c.isPaid !== null && typeof c.isPaid !== 'boolean'
            || c.durationHours !== null && (!Number.isInteger(c.durationHours) || (c.durationHours as number) < 0)) throw new Error('INVALID_FACTS');
        nullable(c.optionalCosts); nullable(c.providerLevel); nullable(c.language);
        names(c.learningOutcomes); names(c.evidenceSections); names(c.operationalWarnings); list(c.skillProposals);
        for (const s of c.skillProposals) { object(s,['label','rationale']); text(s.label); text(s.rationale); }
        if (!c.evidenceSections.length || !c.learningOutcomes.length) throw new Error('EVIDENCE_REQUIRED');
    }
    return value as unknown as OfficialRegistry;
}
export function reviewTemplate(value: unknown): EditorialReview {
    const r = parseOfficialRegistry(value);
    return { formatVersion: 1,purpose: 'editorial_review',reviewer: null,reviewedAt: null,contentSha256: null,
        vocabulary: { names: [],reference: null,checkedOn: null },
        decisions: r.candidates.map(c => ({ url: c.url,decision: 'pending',associations: [],
            confirmations: { title: false,url: false,cost: false,availability: false,rights: false,warnings: false },noSkillsReason: null,note: null })) };
}
function parseReview(value: unknown): EditorialReview {
    object(value,['formatVersion','purpose','reviewer','reviewedAt','contentSha256','vocabulary','decisions']);
    if (value.formatVersion !== 1 || !['editorial_review','TEST_ONLY'].includes(value.purpose as string)) throw new Error('INVALID_REVIEW');
    nullable(value.reviewer); nullable(value.contentSha256);
    if (value.reviewedAt !== null) {
        text(value.reviewedAt);
        if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(value.reviewedAt as string)
            || new Date(value.reviewedAt as string).toISOString() !== value.reviewedAt) throw new Error('INVALID_REVIEW_TIME');
    }
    object(value.vocabulary,['names','reference','checkedOn']); names(value.vocabulary.names); nullable(value.vocabulary.reference);
    if (value.vocabulary.checkedOn !== null) day(value.vocabulary.checkedOn);
    list(value.decisions);
    for (const d of value.decisions) {
        object(d,['url','decision','associations','confirmations','noSkillsReason','note']); officialUrl(d.url);
        if (!['pending','approved','rejected'].includes(d.decision as string)) throw new Error('INVALID_DECISION');
        object(d.confirmations,[...checks]); checks.forEach(k => { if (typeof (d.confirmations as Record<string,unknown>)[k] !== 'boolean') throw new Error('EXPLICIT_CONFIRMATION_REQUIRED'); });
        nullable(d.noSkillsReason); nullable(d.note); list(d.associations);
        d.associations.forEach(a => { object(a,['proposal','canonicalName','rationale']); text(a.proposal); text(a.canonicalName); text(a.rationale); });
    }
    return value as unknown as EditorialReview;
}
function canonical(v: unknown): string {
    if (Array.isArray(v)) return `[${v.map(canonical).join(',')}]`;
    if (v && typeof v === 'object') return `{${Object.entries(v).sort(([a],[b]) => a < b ? -1 : a > b ? 1 : 0).map(([k,x]) => `${JSON.stringify(k)}:${canonical(x)}`).join(',')}}`;
    return JSON.stringify(v);
}
// Content integrity only, not a signature or proof of a human's identity.
export function editorialContentHash(registry: unknown, review: unknown): string {
    const r = parseOfficialRegistry(registry), a = parseReview(review);
    return createHash('sha256').update(canonical({ registry: r,purpose: a.purpose,vocabulary: a.vocabulary,decisions: a.decisions })).digest('hex');
}
export function prepareEditorialCatalog(value: unknown, reviewValue?: unknown) {
    const registry = parseOfficialRegistry(value), review = parseReview(reviewValue ?? reviewTemplate(registry));
    const hash = editorialContentHash(registry,review);
    if (new Set(review.decisions.map(d => d.url)).size !== review.decisions.length
        || review.decisions.some(d => !registry.candidates.some(c => c.url === d.url))) throw new Error('UNKNOWN_OR_DUPLICATE_REVIEW_URL');
    const urls = registry.candidates.flatMap(c => [c.url,...c.aliases]);
    const courses: CatalogCourse[] = [];
    const rows = registry.candidates.map(c => {
        const decision = review.decisions.find(d => d.url === c.url), blockers: string[] = [];
        if ([c.url,...c.aliases].some(url => urls.filter(u => u === url).length !== 1)) blockers.push('URL_OR_ALIAS_COLLISION');
        if (!decision || decision.decision !== 'approved') blockers.push('EXPLICIT_REVIEW_REQUIRED');
        if (!review.reviewer || !review.reviewedAt) blockers.push('REVIEWER_AND_TIME_REQUIRED');
        if (review.contentSha256 !== hash) blockers.push('REVIEW_CONTENT_NOT_CONFIRMED');
        if (review.purpose === 'TEST_ONLY' && !review.reviewer?.startsWith('TEST')) blockers.push('TEST_REVIEWER_REQUIRED');
        if (c.availability !== 'page_accessible' || c.isPaid === null) blockers.push('ACCESS_UNVERIFIED');
        if (review.reviewedAt && (review.reviewedAt.slice(0,10) < registry.checkedOn
            || review.vocabulary.checkedOn && review.reviewedAt.slice(0,10) < review.vocabulary.checkedOn)) blockers.push('REVIEW_PREDATES_EVIDENCE');
        if (decision) {
            checks.forEach(k => { if (!decision.confirmations[k]) blockers.push(`CONFIRM_${k.toUpperCase()}`); });
            if (decision.decision === 'approved' && c.operationalWarnings.length && !decision.note) {
                blockers.push('WARNINGS_ASSESSMENT_REQUIRED');
            }
            if (decision.associations.length && (!review.vocabulary.reference || !review.vocabulary.checkedOn)) blockers.push('VOCABULARY_UNVERIFIED');
            for (const a of decision.associations) {
                if (!c.skillProposals.some(p => p.label === a.proposal)) blockers.push('UNKNOWN_SKILL_PROPOSAL');
                if (!review.vocabulary.names.includes(a.canonicalName)) blockers.push('EXACT_SKILL_MATCH_REQUIRED');
            }
            if (new Set(decision.associations.map(a => a.canonicalName)).size !== decision.associations.length) blockers.push('DUPLICATE_SKILL');
            if (!decision.associations.length && !decision.noSkillsReason) blockers.push('NO_SKILLS_JUSTIFICATION_REQUIRED');
        }
        if (!blockers.length) courses.push({ title: c.title,platform: c.platform,url: c.url,isPaid: c.isPaid!,durationHours: c.durationHours,
            logoUrl: null,skills: decision!.associations.map(a => a.canonicalName).sort(),sourceReference: [
                registry.attribution,registry.sourceKind,c.url,registry.checkedOn,...c.evidenceSections,registry.rightsReference,
                review.vocabulary.reference ?? 'no associated skills',`review ${review.reviewer} ${review.reviewedAt}`,`sha256 ${hash}`].join(' | ') });
        return { url: c.url,title: c.title,status: blockers.length ? 'pending'
            : review.purpose === 'TEST_ONLY' ? 'TEST_ONLY_ELIGIBLE' : 'eligible_for_administrative_plan',blockers };
    });
    const catalog = courses.length ? parseCatalogDocument({ formatVersion: 1,
        batchId: (review.purpose === 'TEST_ONLY' ? 'TEST-' : '') + registry.batchId,reviewedAt: review.reviewedAt,skills: [],courses }) : null;
    return { authorizedToPublish: false,purpose: review.purpose,contentSha256: hash,rows,catalog };
}
