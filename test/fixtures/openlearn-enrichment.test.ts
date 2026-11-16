import { contentHash, type Pilot } from '../../scripts/openlearn-enrichment/review.js';

// Synthetic TEST data only. Never a captured course or real approval.
export function syntheticPilot(): Pilot {
    const facts: Pilot['candidates'][number]['facts'] = {
        sourceId: 'TEST-1', title: 'TEST course', url: 'https://www.open.edu/openlearn/test-course/content-section-0',
        platform: 'TEST OpenLearn', availability: 'available', language: 'TEST language', level: 'TEST Level 1',
        durationHours: 4, isPaid: false, attribution: 'TEST attribution', metadataLicense: 'https://example.org/test-license',
    };
    return { formatVersion: 1, batchId: 'TEST-only', vocabulary: { names: ['TEST SQL'], reference: 'https://example.org/test-vocabulary', checkedOn: '2026-01-01' },
        candidates: [{ facts, subjects: ['TEST subject'], optionalCosts: null, pageLicenseNotice: 'TEST license notice',
            checks: Object.entries(facts).map(([field, value]) => ({ field: field as keyof typeof facts, value, reference: 'https://example.org/test-evidence', checkedOn: '2026-01-01', note: 'TEST evidence' })),
            skillProposals: [{ label: 'TEST proposed skill', rationale: 'TEST learning outcome', evidenceReference: 'https://example.org/test-outcomes', canonicalName: 'TEST SQL', decision: 'approved' }], review: null }] };
}
export function approve(p: Pilot) {
    for (const c of p.candidates) c.review = { reviewer: 'TEST reviewer', approvedAt: '2026-01-02T00:00:00.000Z', contentSha256: contentHash(c, p.vocabulary),
        title: true, url: true, cost: true, skills: true, rights: true, availability: true, noSkillsReason: c.skillProposals.some(s => s.decision === 'approved') ? null : 'TEST no verified match, explicitly approved without skills' };
    return p;
}
