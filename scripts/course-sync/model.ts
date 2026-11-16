import type { CourseCandidate } from '../course-discovery/model.js';

// Extend the discovery vocabulary; provider observations never grant approval.
export interface SyncCandidate extends Pick<CourseCandidate, 'externalId' | 'title' | 'platform' |
    'canonicalUrl' | 'associatedSkills' | 'language' | 'durationMinutes' | 'isPaid' | 'validation' | 'evidence'> {
    sourceId: string;
    price?: { amount: string; currency: string } | null;
    lastSeenAt: string;
    modality: 'virtual' | 'presential' | 'hybrid' | 'unknown';
    geography: { country: string | null; region: string | null; locality: string | null } | null;
    availability: 'available' | 'unavailable' | 'withdrawn' | 'unknown';
    // A course survives the end/withdrawal of an individual offering.
    offerings: { externalId: string; availability: SyncCandidate['availability'];
        startsAt: string | null; endsAt: string | null;
        modality: SyncCandidate['modality']; geography: SyncCandidate['geography'] }[];
}
export interface StoredCourse {
    internalId: string;
    origin: 'manual' | 'sync';
    course: SyncCandidate;
    missingCount: number;
    publication: 'draft' | 'published' | 'inactive';
}
export interface SyncRun {
    runId: string;
    sourceId: string;
    observedAt: string;
    scope: 'full_catalog' | 'query';
    status: 'complete' | 'partial' | 'failed';
    valid: boolean;
    missingPages: boolean;
    quotaLimited: boolean;
    errors: string[];
    candidates: unknown[];
}
export interface Snapshot {
    courses: StoredCourse[];
    checkpoints: Record<string, { runId: string; observedAt: string }>;
}
export interface SyncAction {
    identity: string;
    internalId: string | null;
    kind: 'insert' | 'unchanged' | 'update' | 'missing' | 'deactivation_candidate' |
        'withdrawn' | 'invalid' | 'ambiguous' | 'duplicate' | 'manual_protected';
    decision: 'no_publication_change' | 'human_review';
    reason: string;
}
export interface SyncPlan {
    mode: 'dry-run';
    actions: SyncAction[];
    absenceEligible: boolean;
    massWithdrawalBlocked: boolean;
    skipped: boolean;
    // Projection in memory only; not an import document or authorization to write.
    next: Snapshot;
}

export function fromDiscovery(candidate: CourseCandidate): SyncCandidate {
    return { sourceId: candidate.source, externalId: candidate.externalId, title: candidate.title,
        platform: candidate.platform, canonicalUrl: candidate.canonicalUrl, associatedSkills: candidate.associatedSkills,
        language: candidate.language, durationMinutes: candidate.durationMinutes, isPaid: candidate.isPaid,
        validation: candidate.validation, evidence: candidate.evidence, lastSeenAt: candidate.queriedAt,
        modality: 'unknown', geography: null, availability: 'unknown', offerings: [] };
}
