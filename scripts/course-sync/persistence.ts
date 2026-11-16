import type { Snapshot, SyncPlan, SyncRun } from './model.js';

export interface StagingSnapshot {
    snapshot: Snapshot;
    versions: Record<string, number>;
}
export interface StagingResult {
    replay: boolean;
    skipped: boolean;
    actions: SyncPlan['actions'];
    absenceEligible: boolean;
    massWithdrawalBlocked: boolean;
}
// Implementations own the transaction: snapshot, reconcile, observations and checkpoint.
export interface CourseSyncStaging {
    load(): Promise<StagingSnapshot>;
    execute(run: SyncRun, expectedVersions?: Record<string, number>): Promise<StagingResult>;
}
