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
export interface StagingHistoryEntry {
    runId: string;
    observedAt: string;
    scope: SyncRun['scope'];
    status: SyncRun['status'];
    coverage: Pick<SyncRun,'valid' | 'missingPages' | 'quotaLimited' | 'errors'>;
    result: StagingResult;
}
// Implementations own the transaction: snapshot, reconcile, observations and checkpoint.
export interface CourseSyncStaging {
    load(): Promise<StagingSnapshot>;
    history(sourceId: string, limit?: number): Promise<StagingHistoryEntry[]>;
    execute(run: SyncRun, expectedVersions?: Record<string, number>): Promise<StagingResult>;
}
