import { text } from '../course-discovery/model.js';
import type { Snapshot, StoredCourse, SyncAction, SyncCandidate, SyncPlan, SyncRun } from './model.js';
import { canonicalUrl, identity, metadata, normalize, timestamp } from './validation.js';

export function reconcile(snapshot: Snapshot, run: SyncRun): SyncPlan {
    text(run.runId); text(run.sourceId); timestamp(run.observedAt);
    if (!Array.isArray(run.candidates) || !Array.isArray(run.errors)) throw new Error('INVALID_RUN');
    const next = structuredClone(snapshot);
    const plan: SyncPlan = { mode: 'dry-run', actions: [], absenceEligible: false,
        massWithdrawalBlocked: false, skipped: false, next };
    const checkpoint = Object.hasOwn(snapshot.checkpoints, run.sourceId) ? snapshot.checkpoints[run.sourceId] : undefined;
    if (checkpoint && (checkpoint.runId === run.runId || checkpoint.observedAt >= run.observedAt)) {
        plan.skipped = true; return plan;
    }
    const ids = new Set<string>();
    for (const row of next.courses) {
        text(row.internalId);
        if (ids.has(row.internalId) || !Number.isSafeInteger(row.missingCount) || row.missingCount < 0) throw new Error('INVALID_SNAPSHOT');
        ids.add(row.internalId);
    }
    const action = (key: string, row: StoredCourse | undefined, kind: SyncAction['kind'], reason: string) => {
        plan.actions.push({ identity: key, internalId: row?.internalId ?? null, kind, reason,
            decision: ['insert', 'update', 'deactivation_candidate', 'withdrawn', 'invalid', 'ambiguous'].includes(kind)
                ? 'human_review' : 'no_publication_change' });
    };
    let unsafe = false;
    for (const row of next.courses.filter(r => r.origin === 'sync' && r.course.sourceId === run.sourceId)) {
        if (next.courses.some(other => other !== row && (identity(other.course) === identity(row.course)
            || canonicalUrl(other.course.canonicalUrl) === canonicalUrl(row.course.canonicalUrl)))) {
            unsafe = true;
            action(identity(row.course), row, 'ambiguous', 'EXISTING_CATALOG_COLLISION');
        }
    }
    const groups = new Map<string, SyncCandidate[]>();
    for (const [index, raw] of run.candidates.entries()) {
        try {
            const c = normalize(raw, run.sourceId, run.observedAt), key = identity(c);
            if (checkpoint && c.lastSeenAt <= checkpoint.observedAt) throw new Error('STALE_OBSERVATION');
            groups.set(key, [...(groups.get(key) ?? []), c]);
        } catch {
            unsafe = true; action(`invalid:${index}`, undefined, 'invalid', 'INVALID_OR_INCOMPLETE_RECORD');
        }
    }
    const seen = new Set<string>();
    const observed = new Map<string, SyncCandidate>();
    for (const [key, group] of [...groups].sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0)) {
        seen.add(key);
        const c = group[0]!;
        const matches = next.courses.filter(r => identity(r.course) === key);
        // URL matches are only a fallback when BOTH records lack stable IDs.
        // Any different identity on the same URL is ambiguous, never silently merged.
        const urlCollisions = next.courses.filter(r => canonicalUrl(r.course.canonicalUrl) === c.canonicalUrl && identity(r.course) !== key);
        const discoveredCollision = [...groups].some(([other, candidates]) => other !== key && candidates.some(x => x.canonicalUrl === c.canonicalUrl));
        const manual = next.courses.find(r => r.origin === 'manual' && (identity(r.course) === key || canonicalUrl(r.course.canonicalUrl) === c.canonicalUrl));
        if (manual) { action(key, manual, 'manual_protected', 'MANUAL_OWNERSHIP'); continue; }
        if (matches.length > 1 || urlCollisions.length || discoveredCollision || group.some(x => metadata(x) !== metadata(c)) || c.validation === 'conflict') {
            unsafe = true; action(key, matches[0], 'ambiguous', 'IDENTITY_OR_METADATA_CONFLICT'); continue;
        }
        if (group.length > 1) action(key, matches[0], 'duplicate', 'IDENTICAL_OBSERVATIONS_COLLAPSED');
        observed.set(key, { ...c, evidence: [...new Map(group.flatMap(x => x.evidence)
            .map(e => [JSON.stringify(e), e])).entries()].sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0).map(([, e]) => e) });
    }
    const managed = next.courses.filter(r => r.origin === 'sync' && r.course.sourceId === run.sourceId);
    plan.absenceEligible = run.scope === 'full_catalog' && run.status === 'complete' && run.valid === true
        && run.missingPages === false && run.quotaLimited === false && run.errors.length === 0 && !unsafe;
    const removalCount = managed.filter(r => r.publication !== 'inactive' &&
        ((!seen.has(identity(r.course)) && plan.absenceEligible) || observed.get(identity(r.course))?.availability === 'withdrawn')).length;
    const activeCount = managed.filter(r => r.publication !== 'inactive').length;
    // Initial conservative policy: at least three courses AND more than half the managed catalog.
    plan.massWithdrawalBlocked = removalCount >= 3 && removalCount / activeCount > 0.5;
    if (plan.massWithdrawalBlocked) plan.absenceEligible = false;

    for (const [key, c] of observed) {
        const row = next.courses.find(r => identity(r.course) === key);
        if (c.availability === 'withdrawn' && plan.massWithdrawalBlocked) {
            action(key, row, 'ambiguous', 'MASS_WITHDRAWAL_BLOCKED'); continue;
        }
        if (!row) {
            // Namespaced, deterministic proposal ID; not a PostgreSQL course_id.
            const internalId = `proposal:${key}`;
            if (ids.has(internalId)) throw new Error('PROPOSAL_ID_COLLISION');
            ids.add(internalId);
            next.courses.push({ internalId, origin: 'sync', course: c, missingCount: 0, publication: 'draft' });
            action(key, undefined, c.availability === 'withdrawn' ? 'withdrawn' : 'insert', 'PUBLICATION_REQUIRES_APPROVAL');
        } else {
            // Missing offerings are retained; adapters must explicitly report their withdrawal.
            const merged = { ...c, offerings: [...new Map([...row.course.offerings, ...c.offerings].map(o => [o.externalId, o])).values()]
                .sort((a, b) => a.externalId < b.externalId ? -1 : a.externalId > b.externalId ? 1 : 0) };
            const changed = metadata(row.course) !== metadata(merged);
            action(key, row, c.availability === 'withdrawn' ? 'withdrawn' : changed ? 'update' : 'unchanged',
                c.availability === 'withdrawn' ? 'EXPLICIT_SOURCE_WITHDRAWAL_REQUIRES_REVIEW' : changed ? 'METADATA_CHANGE_REQUIRES_APPROVAL' : 'OBSERVED');
            row.course = merged; row.missingCount = 0;
        }
    }
    for (const row of managed) {
        if (seen.has(identity(row.course)) || !plan.absenceEligible) continue;
        row.missingCount = Math.min(3, row.missingCount + 1);
        action(identity(row.course), row, row.missingCount >= 3 ? 'deactivation_candidate' : 'missing',
            row.missingCount >= 3 ? 'THREE_COMPLETE_ABSENCES_REQUIRES_REVIEW' : 'COMPLETE_ABSENCE');
    }
    Object.defineProperty(next.checkpoints, run.sourceId, { value: { runId: run.runId, observedAt: run.observedAt },
        enumerable: true, writable: true, configurable: true });
    next.courses.sort((a, b) => a.internalId < b.internalId ? -1 : a.internalId > b.internalId ? 1 : 0);
    return plan;
}
