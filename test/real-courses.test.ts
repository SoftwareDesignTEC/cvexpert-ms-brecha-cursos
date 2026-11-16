import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtemp, writeFile, unlink, rmdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { editorialContentHash, prepareEditorialCatalog, reviewTemplate } from '../scripts/editorial-courses/review.js';
import { parseCatalogDocument } from '../scripts/catalog-import/document.js';
import { preparePilot } from '../scripts/openlearn-enrichment/review.js';
import { runOfficialReview } from '../scripts/review-official-courses.js';
import { realCoursesRegistry, testCourseReview } from './fixtures/real-courses.test.js';
import { prepareInput } from '../scripts/admin-import/planner.js';

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
    assert.deepEqual(vocabulary,{ names: ['Python'],reference: 'TEST reviewed vocabulary, not an operational snapshot',checkedOn: '2026-11-15' });
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
        const report = await runOfficialReview(['report','--file',registry,'--review',file]) as any;
        assert.equal(report.catalog,null);
        assert.equal(report.catalogSuppressedReason,'TEST_ONLY');
        assert.equal(report.purpose,'TEST_ONLY'); assert.equal(report.authorizedToPublish,false);
        assert.ok(report.rows.some((r: any) => r.status === 'TEST_ONLY_ELIGIBLE'));
        assert.ok(report.rows.some((r: any) => r.blockers.includes('EXPLICIT_REVIEW_REQUIRED')));
        assert.match(report.contentSha256,/^[a-f0-9]{64}$/);
    } finally { await unlink(file); await rmdir(dir); }
});

test('administrative boundary rejects reserved TEST batches even with formally valid market/scale fixtures', async () => {
    // Existing, explicitly synthetic fixtures exercise validation only; no operational market is created.
    const market = JSON.parse(await readFile(new URL('./fixtures/market-import.test.json',import.meta.url),'utf8'));
    const scale = JSON.parse(await readFile(new URL('./fixtures/market-import.test-scale.json',import.meta.url),'utf8'));
    const registry = realCoursesRegistry(), review = testCourseReview(registry,vocabulary);
    const doc = prepareEditorialCatalog(registry,review).catalog!;
    for (const batchId of [doc.batchId,'TEST_ONLY','TEST_ONLY:editorial','TEST_ONLY-editorial']) {
        assert.throws(() => prepareInput({ ...doc,batchId },market,scale),/rechaza lotes TEST_ONLY/);
    }
    // Ordinary complete review branch is simulated by a clearly TEST-named reviewer, not a real human approval.
    review.purpose = 'editorial_review';
    review.reviewer = 'TEST simulated ordinary reviewer, no operational approval';
    review.contentSha256 = editorialContentHash(registry,review);
    const ordinary = prepareEditorialCatalog(registry,review);
    assert.ok(ordinary.catalog); assert.equal(ordinary.authorizedToPublish,false);
    const accepted = prepareInput(ordinary.catalog,market,scale);
    assert.ok(accepted.catalog.courses.some(c => c.title === 'Simple coding'));
    // A legitimate title containing common test terminology is not a TEST_ONLY marker.
    assert.doesNotThrow(() => prepareInput({ ...ordinary.catalog,courses: ordinary.catalog!.courses.map(c =>
        ({ ...c,title: 'Introduction to software testing' })) },market,scale));
    const dir = await mkdtemp(join(tmpdir(),'ordinary-review-')), file = join(dir,'TEST-simulated-ordinary-review.json');
    try {
        await writeFile(file,JSON.stringify(review));
        const args = ['--file','docs/providers/openlearn-real-courses.json','--review',file];
        const exported = await runOfficialReview(['catalog',...args]);
        assert.deepEqual(exported,ordinary.catalog);
        assert.deepEqual((await runOfficialReview(['report',...args]) as any).catalog,ordinary.catalog);
    } finally { await unlink(file); await rmdir(dir); }
});

test('Simple coding user warning preserves availability and requires explicit warning confirmation', async () => {
    const registry = realCoursesRegistry(), c = registry.candidates[0]!;
    assert.equal(c.title,'Simple coding'); assert.equal(c.availability,'page_accessible');
    assert.ok(c.operationalWarnings.some(w => w.includes('Trinket') && w.includes('no un fallo técnico confirmado')));
    const review = testCourseReview(registry,vocabulary);
    review.decisions[0]!.confirmations.warnings = false;
    review.contentSha256 = editorialContentHash(registry,review);
    assert.ok(prepareEditorialCatalog(registry,review).rows[0]!.blockers.includes('CONFIRM_WARNINGS'));
    review.decisions[0]!.confirmations.warnings = true; review.decisions[0]!.note = null;
    review.contentSha256 = editorialContentHash(registry,review);
    assert.ok(prepareEditorialCatalog(registry,review).rows[0]!.blockers.includes('WARNINGS_ASSESSMENT_REQUIRED'));
    const withoutWarning = structuredClone(registry);
    withoutWarning.candidates[0]!.operationalWarnings = c.operationalWarnings.filter(w => !w.includes('Trinket'));
    assert.notEqual(editorialContentHash(withoutWarning,review),editorialContentHash(registry,review));
    const pending = JSON.parse(await readFile(new URL('../docs/providers/openlearn-real-courses-report.pending.json',import.meta.url),'utf8'));
    assert.deepEqual(pending,prepareEditorialCatalog(registry));
    const template = JSON.parse(await readFile(new URL('../docs/providers/openlearn-real-courses-review.pending.json',import.meta.url),'utf8'));
    assert.deepEqual(template,reviewTemplate(registry)); assert.equal(template.contentSha256,null);
});
