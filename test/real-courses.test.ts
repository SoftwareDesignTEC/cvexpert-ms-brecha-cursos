import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtemp, writeFile, unlink, rmdir } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { editorialContentHash, prepareEditorialCatalog, reviewTemplate } from '../scripts/editorial-courses/review.js';
import { parseCatalogDocument } from '../scripts/catalog-import/document.js';
import { preparePilot } from '../scripts/openlearn-enrichment/review.js';
import { runOfficialReview } from '../scripts/review-official-courses.js';
import { realCoursesRegistry, testCourseReview } from './fixtures/real-courses.test.js';

const vocabulary = { names: ['Python'],reference: 'TEST reviewed vocabulary, not an operational snapshot',checkedOn: '2026-11-15' };
test('real official metadata remains pending with no manufactured reviewer, vocabulary or RDF identity', () => {
    const registry = realCoursesRegistry(), report = prepareEditorialCatalog(registry);
    assert.equal(registry.candidates.length,6);
    assert.ok(registry.candidates.every(c => c.rdfIdentity === null && c.editorialStatus === 'pending'));
    assert.ok(report.rows.every(r => r.status === 'pending' && r.blockers.includes('EXPLICIT_REVIEW_REQUIRED')));
    assert.equal(report.catalog,null); assert.equal(report.authorizedToPublish,false);
    assert.equal(reviewTemplate(registry).reviewer,null); assert.deepEqual(reviewTemplate(registry).vocabulary.names,[]);
    assert.throws(() => preparePilot(registry),'URL editorial registry must not masquerade as RDF pilot');
});
test('TEST approval produces valid real-course CatalogDocument v1 with exact Python and no inferred skills', () => {
    const registry = realCoursesRegistry(), review = testCourseReview(registry,vocabulary);
    const report = prepareEditorialCatalog(registry,review), doc = parseCatalogDocument(report.catalog);
    assert.equal(doc.courses.length,2); assert.deepEqual(doc.skills,[]); assert.match(doc.batchId,/^TEST-/);
    const python = doc.courses.find(c => c.title === 'Simple coding')!;
    assert.deepEqual(python.skills,['Python']); assert.equal(python.durationHours,2); assert.equal(python.isPaid,false);
    assert.match(python.sourceReference,/editorial_official_page_url/); assert.match(python.sourceReference,/TEST automated fixture/);
    assert.ok(python.sourceReference.includes(python.url)); assert.equal(python.sourceReference.includes('OpenLearn ID'),false);
    assert.deepEqual(doc.courses.find(c => c.title === 'Network security')!.skills,[]);
    assert.equal(report.authorizedToPublish,false);
    assert.ok(report.rows.filter(r => !r.blockers.length).every(r => r.status === 'TEST_ONLY_ELIGIBLE'));
});
test('missing canonical skill, changed review content, stale approval and unconfirmed rights block eligibility', () => {
    const registry = realCoursesRegistry();
    for (const mutation of ['case','vocabulary','rights','warning','hash','date'] as const) {
        const review = testCourseReview(registry,vocabulary);
        const decision = review.decisions[0]!;
        if (mutation === 'case') decision.associations[0]!.canonicalName = 'python';
        if (mutation === 'vocabulary') review.vocabulary.reference = null;
        if (mutation === 'rights') decision.confirmations.rights = false;
        if (mutation === 'warning') decision.confirmations.warnings = false;
        if (mutation === 'date') review.reviewedAt = '2026-11-14T00:00:00.000Z';
        if (mutation !== 'hash') review.contentSha256 = editorialContentHash(registry,review);
        else decision.note = 'TEST changed after content confirmation';
        assert.ok(prepareEditorialCatalog(registry,review).rows[0]!.blockers.length,mutation);
    }
    const edited = structuredClone(registry), review = testCourseReview(registry,vocabulary);
    edited.candidates[0]!.durationHours = 3;
    assert.ok(prepareEditorialCatalog(edited,review).rows[0]!.blockers.includes('REVIEW_CONTENT_NOT_CONFIRMED'));
});
test('exact URL and verified redirect aliases block duplicate editorial identities without rewriting URLs', () => {
    const registry = realCoursesRegistry();
    registry.candidates[0]!.aliases = [registry.candidates[1]!.url];
    const review = testCourseReview(registry,vocabulary);
    const report = prepareEditorialCatalog(registry,review);
    assert.equal(report.catalog,null); assert.ok(report.rows.slice(0,2).every(r => r.blockers.includes('URL_OR_ALIAS_COLLISION')));
});
test('editorial CLI is offline, pending by default and refuses operational export of TEST approvals', async t => {
    t.mock.method(globalThis,'fetch',async () => { throw new Error('EXTERNAL_NETWORK_FORBIDDEN'); });
    const registry = 'docs/providers/openlearn-real-courses.json';
    assert.equal((await runOfficialReview(['report','--file',registry]) as any).catalog,null);
    await assert.rejects(runOfficialReview(['catalog','--file',registry]),/NO_OPERATIONAL/);
    const dir = await mkdtemp(join(tmpdir(),'real-course-review-')),file = join(dir,'TEST-review.json');
    try {
        await writeFile(file,JSON.stringify(testCourseReview(realCoursesRegistry(),vocabulary)));
        await assert.rejects(runOfficialReview(['catalog','--file',registry,'--review',file]),/NO_OPERATIONAL/);
    } finally { await unlink(file); await rmdir(dir); }
});
