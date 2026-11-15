import type { Snapshot, SyncCandidate, SyncRun } from '../../scripts/course-sync/model.js';

// Entirely synthetic TEST data. No provider URLs, credentials or real courses.
export const testTime = '2026-11-15T12:00:00.000Z';
export function testCandidate(extra: Partial<SyncCandidate> = {}): SyncCandidate {
    return { sourceId: 'TEST-provider', externalId: 'TEST-agriculture', title: '[TEST] Agricultura sostenible',
        platform: '[TEST] Formación multidisciplinaria', canonicalUrl: 'https://example.org/TEST/agriculture',
        associatedSkills: ['[TEST] Agricultura'], language: null, durationMinutes: null, isPaid: null,
        validation: 'needs_review', lastSeenAt: testTime, modality: 'unknown', geography: null,
        availability: 'unknown', offerings: [], evidence: [{ apiUrl: 'https://example.org/TEST/api',
            responseSha256: '0'.repeat(64), summary: '[TEST] Evidencia ficticia', products: [], subjects: [],
            returnedUrl: 'https://example.org/TEST/agriculture', title: '[TEST] Agricultura sostenible',
            queriedAt: testTime, durationMinutes: null, language: null, levels: [] }], ...extra };
}
export function testRun(extra: Partial<SyncRun> = {}): SyncRun {
    return { runId: 'TEST-run-1', sourceId: 'TEST-provider', observedAt: testTime, scope: 'full_catalog',
        status: 'complete', valid: true, missingPages: false, quotaLimited: false, errors: [],
        candidates: [testCandidate()], ...extra };
}
export function testSnapshot(): Snapshot {
    return { courses: [], checkpoints: {} };
}
