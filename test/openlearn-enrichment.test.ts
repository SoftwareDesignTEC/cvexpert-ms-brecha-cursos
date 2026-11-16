import assert from 'node:assert/strict';
import { test } from 'node:test';
import { spawnSync } from 'node:child_process';
import { preparePilot, contentHash } from '../scripts/openlearn-enrichment/review.js';
import { approve, syntheticPilot } from './fixtures/openlearn-enrichment.test.js';

test('complete reviewed course produces valid v1 without inferred skill creation', () => {
    const r = preparePilot(approve(syntheticPilot()));
    assert.equal(r.catalog?.courses.length, 1); assert.deepEqual(r.catalog?.skills, []);
    assert.deepEqual(r.catalog?.courses[0]?.skills, ['TEST SQL']); assert.equal(r.authorizedToPublish, false);
    assert.match(r.catalog!.courses[0]!.sourceReference, /TEST attribution.*test-license.*test-evidence.*sha256/);
    assert.equal(r.catalog!.courses[0]!.durationHours, 4); assert.equal(r.catalog!.courses[0]!.logoUrl, null);
});
test('unknown access cost never becomes false and unavailable course is excluded', () => {
    const p = syntheticPilot(), c = p.candidates[0]!; c.facts.isPaid = null; c.facts.availability = 'unknown';
    c.checks = c.checks.filter(e => !['isPaid', 'availability'].includes(e.field));
    const r = preparePilot(approve(p)); assert.equal(r.catalog, null);
    assert.ok(r.rows[0]!.blockers.includes('ACCESS_COST_UNKNOWN')); assert.ok(r.rows[0]!.blockers.includes('AVAILABILITY_UNVERIFIED'));
});
test('optional unknown fields remain null and native level is not mapped to skill proficiency', () => {
    const p = syntheticPilot(), c = p.candidates[0]!; c.facts.durationHours = c.facts.language = c.facts.level = null;
    c.checks = c.checks.filter(e => !['durationHours', 'language', 'level'].includes(e.field));
    const r = preparePilot(approve(p)); assert.equal(r.catalog!.courses[0]!.durationHours, null);
    assert.ok(!Object.hasOwn(r.catalog!.courses[0]!, 'level'));
});
test('ambiguous pending proposals, missing evidence and inexact names block association', () => {
    for (const change of ['pending', 'evidence', 'case', 'unicode', 'vocabulary'] as const) {
        const p = syntheticPilot(), s = p.candidates[0]!.skillProposals[0]!;
        if (change === 'pending') { s.decision = 'pending'; s.canonicalName = null; }
        if (change === 'evidence') s.evidenceReference = null;
        if (change === 'case') s.canonicalName = 'test SQL';
        if (change === 'unicode') s.canonicalName = 'TEST SＱL';
        if (change === 'vocabulary') p.vocabulary.reference = null;
        assert.equal(preparePilot(approve(p)).catalog, null, change);
    }
});
test('no skills allowed only with explicit reviewed justification, subjects never become skills', () => {
    const p = syntheticPilot(); p.candidates[0]!.skillProposals = []; approve(p);
    assert.deepEqual(preparePilot(p).catalog!.courses[0]!.skills, []);
    p.candidates[0]!.review!.noSkillsReason = null; assert.equal(preparePilot(p).catalog, null);
});
test('paid optional services do not change individually evidenced free course access', () => {
    const p = syntheticPilot(); p.candidates[0]!.optionalCosts = 'TEST optional certificate costs money';
    assert.equal(preparePilot(approve(p)).catalog!.courses[0]!.isPaid, false);
    p.candidates[0]!.facts.isPaid = null; p.candidates[0]!.checks = p.candidates[0]!.checks.filter(e => e.field !== 'isPaid');
    assert.equal(preparePilot(approve(p)).catalog, null);
});
test('fractional hours are blocked instead of rounded, whole hours and zero preserved', () => {
    for (const hours of [0, 7, 1.5, 2147483648]) {
        const p = syntheticPilot(), c = p.candidates[0]!; c.facts.durationHours = hours;
        c.checks.find(e => e.field === 'durationHours')!.value = hours;
        const r = preparePilot(approve(p));
        if (Number.isInteger(hours) && hours <= 2147483647) assert.equal(r.catalog!.courses[0]!.durationHours, hours);
        else assert.ok(r.rows[0]!.blockers.includes('DURATION_NOT_REPRESENTABLE_IN_V1'));
    }
});
test('duplicate URL blocks all copies, duplicate identity also requires review', () => {
    for (const field of ['url', 'sourceId'] as const) {
        const p = syntheticPilot(), copy = structuredClone(p.candidates[0]!);
        if (field === 'url') copy.facts.sourceId = 'TEST-2'; else copy.facts.url = 'https://www.open.edu/openlearn/other-test/content-section-0';
        p.candidates.push(copy); const r = preparePilot(approve(p)); assert.equal(r.catalog, null);
        assert.ok(r.rows.every(row => row.blockers.includes(field === 'url' ? 'DUPLICATE_URL' : 'DUPLICATE_SOURCE_ID')));
    }
});
test('contradictory metadata and missing individual evidence block even approved rows', () => {
    const p = syntheticPilot(), c = p.candidates[0]!;
    c.checks.push({ ...c.checks.find(e => e.field === 'isPaid')!, value: true });
    assert.ok(preparePilot(approve(p)).rows[0]!.blockers.includes('CONTRADICTORY_METADATA:isPaid'));
    c.checks = c.checks.filter(e => e.field !== 'isPaid');
    assert.ok(preparePilot(approve(p)).rows[0]!.blockers.includes('EVIDENCE_MISSING:isPaid'));
});
test('report deterministic and approval invalidated by data, evidence, or vocabulary edits', () => {
    const p = approve(syntheticPilot()); assert.equal(JSON.stringify(preparePilot(p)), JSON.stringify(preparePilot(structuredClone(p))));
    for (const field of ['data', 'evidence', 'vocabulary']) {
        const copy = structuredClone(p);
        if (field === 'data') copy.candidates[0]!.facts.title = 'TEST changed';
        if (field === 'evidence') copy.candidates[0]!.checks[0]!.note = 'TEST changed';
        if (field === 'vocabulary') copy.vocabulary.names.push('TEST new skill');
        assert.ok(preparePilot(copy).rows[0]!.blockers.includes('REVIEW_CONTENT_CHANGED'));
    }
});
test('all approval decisions required, approval must follow evidence, no unsigned publication', () => {
    const p = syntheticPilot(); assert.equal(preparePilot(p).catalog, null);
    for (const field of ['title', 'url', 'cost', 'skills', 'rights', 'availability'] as const) {
        approve(p); p.candidates[0]!.review![field] = false; assert.equal(preparePilot(p).catalog, null);
    }
    approve(p); p.candidates[0]!.review!.approvedAt = '2025-01-01T00:00:00.000Z'; assert.equal(preparePilot(p).catalog, null);
});
test('strict schema rejects coercion, unknown keys, invalid dates and more than ten candidates', () => {
    for (const mutate of [
        (p: any) => p.apply = true, (p: any) => p.candidates[0].facts.isPaid = 'false',
        (p: any) => p.candidates[0].checks[0].checkedOn = '2026-02-30',
        (p: any) => p.candidates = Array(11).fill(p.candidates[0]),
    ]) { const p = syntheticPilot(); mutate(p); assert.throws(() => preparePilot(p)); }
});
test('only reviewed subset is emitted, blocked candidates are retained in report', () => {
    const p = approve(syntheticPilot()), c = structuredClone(p.candidates[0]!);
    c.facts.sourceId = 'TEST-2'; c.facts.url = 'https://www.open.edu/openlearn/test-two/content-section-0'; c.review = null; p.candidates.push(c);
    assert.equal(preparePilot(p).catalog!.courses.length, 1); assert.equal(preparePilot(p).rows.length, 2);
});
test('offline review runs under Node permissions without network, writes, workers, children or DB', () => {
    const script = `import { registerHooks } from 'node:module';
        registerHooks({resolve(s,c,next){try{return next(s,c);}catch(e){if(s.startsWith('.')&&s.endsWith('.js'))return next(s.slice(0,-3)+'.ts',c);throw e;}}});
        const { runReview } = await import('./scripts/review-openlearn.ts');
        const path = 'test/fixtures/openlearn-enrichment-input.test.json';
        for (const args of [['catalog','--file',path],['report','--file',path,'--apply'],['sign','--file',path]]) {
            let rejected = false; try { await runReview(args); } catch { rejected = true; }
            if (!rejected) throw new Error('TEST rejection expected');
        }
        console.log(JSON.stringify(await runReview(['report','--file',path])));`;
    const result = spawnSync(process.execPath, ['--permission', '--allow-fs-read=*', '--experimental-transform-types', '--input-type=module', '-e', script],
        { encoding: 'utf8', env: { PATH: process.env.PATH, SystemRoot: process.env.SystemRoot } });
    assert.equal(result.status, 0, result.stderr); assert.equal(JSON.parse(result.stdout).catalog, null);
});
test('hash excludes only review, preserves exact inputs', () => {
    const p = syntheticPilot(), before = contentHash(p.candidates[0]!, p.vocabulary); approve(p);
    assert.equal(contentHash(p.candidates[0]!, p.vocabulary), before);
});
