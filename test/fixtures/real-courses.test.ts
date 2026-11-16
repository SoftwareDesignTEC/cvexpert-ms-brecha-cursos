import { readFileSync } from 'node:fs';
import { editorialContentHash, parseOfficialRegistry, reviewTemplate, type OfficialRegistry } from '../../scripts/editorial-courses/review.js';

// Real, minimal official metadata. This helper supplies ONLY a synthetic TEST authorization.
export function realCoursesRegistry() {
    return parseOfficialRegistry(JSON.parse(readFileSync(new URL('../../docs/providers/openlearn-real-courses.json',import.meta.url),'utf8')));
}
export const testReviewTime = '2026-11-16T00:00:00.000Z';
export function testCourseReview(registry: OfficialRegistry, vocabulary: { names: string[]; reference: string; checkedOn: string }) {
    const review = reviewTemplate(registry);
    review.purpose = 'TEST_ONLY'; review.reviewer = 'TEST automated fixture, no human approval'; review.reviewedAt = testReviewTime;
    review.vocabulary = structuredClone(vocabulary);
    for (const d of review.decisions) {
        const candidate = registry.candidates.find(c => c.url === d.url)!;
        if (!['Simple coding','Network security'].includes(candidate.title)) continue;
        d.decision = 'approved';
        for (const key of Object.keys(d.confirmations) as (keyof typeof d.confirmations)[]) d.confirmations[key] = true;
        d.note = 'TEST_ONLY authorization for disposable DB demonstration, not a person or operational approval';
        if (candidate.title === 'Simple coding') d.associations = [{ proposal: 'Python',canonicalName: 'Python',rationale: 'TEST review of explicit Python learning outcomes, introductory scope only' }];
        else d.noSkillsReason = 'TEST: no verified matching canonical security skill, deliberately imported without associations';
    }
    review.contentSha256 = editorialContentHash(registry,review);
    return review;
}
