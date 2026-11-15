import { fromDiscovery, type Snapshot } from '../../scripts/course-sync/model.js';
import { openLearnType } from '../../scripts/course-discovery/openlearn-provider.js';

// Synthetic TEST metadata only. None of these are captured or verified real courses.
export const openLearnTestTime = '2026-11-15T22:00:00.000Z';
export const uri = (value: string) => ({ type: 'uri', value });
export const literal = (value: string) => ({ type: 'literal', value });
export function testBinding(id = '990001', discipline = 'education') {
    return { resource: uri(`http://data.open.ac.uk/openlearn/test-${discipline}/test-${id}/content-section-0`),
        type: uri(openLearnType), title: literal(`[TEST] Formación ${discipline}`),
        url: uri(`https://www.open.edu/openlearn/test-${discipline}/test-${id}/content-section-0`),
        internalId: literal(id), subject: literal(`[TEST] ${discipline}`) };
}
export function testSparql(bindings: unknown[]) {
    return { head: { vars: ['resource', 'type', 'title', 'url', 'internalId', 'subject'] }, results: { bindings },
        meta: { 'result-size-total': bindings.length, 'query-time-ms': 0 } };
}
export function openLearnFixture() {
    return testSparql([testBinding(), testBinding('990002', 'languages'), testBinding('990003', 'health'),
        testBinding('990004', 'business'), testBinding('990005', 'science'), testBinding(),
        { ...testBinding('990006'), type: uri('https://schema.org/Article') },
        { ...testBinding('990007'), url: uri('https://example.org/TEST/not-openlearn') }]);
}
export function openLearnTestSnapshot(): Snapshot {
    const row = testBinding();
    const course = fromDiscovery({ source: 'openlearn', externalId: row.internalId.value, title: '[TEST] Título anterior',
        platform: 'OpenLearn — The Open University', canonicalUrl: row.url.value, url: row.url.value,
        associatedSkills: [], language: null, levels: [], durationMinutes: null, isPaid: null, validation: 'needs_review',
        reviewReasons: [], queriedAt: openLearnTestTime, evidence: [] });
    return { checkpoints: {}, courses: [
        { internalId: 'TEST-openlearn-existing', origin: 'sync', course, missingCount: 1, publication: 'published' },
        { internalId: 'TEST-other-provider', origin: 'sync', missingCount: 2, publication: 'published',
            course: { ...course, sourceId: 'TEST-other-provider', externalId: 'TEST-other',
                title: '[TEST] Otra fuente', canonicalUrl: 'https://example.org/TEST/other' } },
    ] };
}
