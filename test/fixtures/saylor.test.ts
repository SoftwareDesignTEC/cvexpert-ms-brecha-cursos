import { fromDiscovery, type Snapshot } from '../../scripts/course-sync/model.js';
import type { CourseCandidate } from '../../scripts/course-discovery/model.js';

// Invented TEST records; this is NOT a captured API response, real syllabus or course.
export const saylorTestTime = '2026-11-15T18:00:00.000Z';
export const saylorFixture = { courses: [
    { id: 990001, category: 99001, shortname: 'TEST-BUS', fullname: '[TEST] Administración de empresas' },
    { id: 990002, category: 99002, shortname: 'TEST-ENG', fullname: '[TEST] Inglés para practicar' },
    { id: 990003, category: 99003, shortname: 'TEST-HUM', fullname: '[TEST] Humanidades' },
    { id: 990004, category: 99004, shortname: 'TEST-SCI', fullname: '[TEST] Ciencias' },
    { id: 990005, category: 99005, shortname: 'TEST-COM', fullname: '[TEST] Comunicación' },
    { id: 990006, category: 99006, shortname: 'TEST-CS', fullname: '[TEST] Informática' },
    { id: 990007, category: 99007, shortname: 'TEST-PD', fullname: '[TEST] Desarrollo profesional' },
    { id: 990001, category: 99001, shortname: 'TEST-BUS', fullname: '[TEST] Administración de empresas' },
] };

export function saylorTestSnapshot(): Snapshot {
    const candidate: CourseCandidate = { source: 'saylor', externalId: '990001', title: '[TEST] Título anterior',
        platform: 'Saylor University', url: 'https://learn.saylor.org/course/view.php?id=990001',
        canonicalUrl: 'https://learn.saylor.org/course/view.php?id=990001', associatedSkills: [],
        queriedAt: saylorTestTime, language: null, levels: [], durationMinutes: null, isPaid: null,
        validation: 'needs_review', reviewReasons: [], evidence: [] };
    return { checkpoints: {}, courses: [
        { internalId: 'TEST-saylor-existing', origin: 'sync', publication: 'published', missingCount: 0, course: fromDiscovery(candidate) },
        { internalId: 'TEST-other-source', origin: 'sync', publication: 'published', missingCount: 2,
            course: fromDiscovery({ ...candidate, source: 'TEST-other-source', externalId: 'TEST-other',
                title: '[TEST] Curso de otra fuente', canonicalUrl: 'https://example.org/TEST/other', url: 'https://example.org/TEST/other' }) },
    ] };
}
