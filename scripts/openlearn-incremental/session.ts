import { createHash, randomUUID } from 'node:crypto';
import { DiscoveryError } from '../course-discovery/model.js';
import { withDiscoveryStore, type LocalArtifacts } from '../course-discovery/store.js';
import type { CourseSyncStaging, StagingResult } from '../course-sync/persistence.js';
import { normalize, timestamp } from '../course-sync/validation.js';
import { PageError, preparePage, queryVersion, resource, type IncrementalArtifact } from './provider.js';

type Mode = 'fixture' | 'live';
export interface Limits { pageSize: number; maxPages: number; maxRequests: number; minIntervalMs: number }
export interface SessionState {
    formatVersion: 1; provider: 'openlearn'; queryVersion: string; mode: Mode; sourceAuthorization: string | null;
    limits: Limits; initialCursor: string | null; confirmedCursor: string | null;
    requests: number; pagesApplied: number; lastRequestAt: number; blockedUntil: number; lastError: string | null;
    pending: { runId: string; observedAt: string; file: string; hash: string | null } | null;
    seen: string[]; exhausted: boolean; target: string | null;
    applied: { runId: string; hash: string; runSha256: string; resources: number; repeated: number; result: StagingResult }[];
}
export function hash(value: unknown): string {
    const canonical = (v: unknown): string => v === null || typeof v !== 'object' ? JSON.stringify(v)
        : Array.isArray(v) ? `[${v.map(canonical).join(',')}]`
            : `{${Object.keys(v).sort().map(k => `${JSON.stringify(k)}:${canonical((v as Record<string,unknown>)[k])}`).join(',')}}`;
    return createHash('sha256').update(canonical(value)).digest('hex');
}
function fail(code: string): never { throw new DiscoveryError(code); }
function limits(input: Limits) {
    for (const [key,min,max] of [['pageSize',1,10],['maxPages',1,2],['maxRequests',1,4],['minIntervalMs',2000,60000]] as const) {
        if (!Number.isInteger(input[key]) || input[key] < min || input[key] > max) fail('INVALID_LIMITS');
    }
    return input;
}
function stateName(mode: Mode) { return `${mode}-openlearn-incremental.json`; }
async function optional(files: LocalArtifacts, name: string): Promise<unknown | undefined> {
    try { return await files.read(name); } catch (e) { if ((e as NodeJS.ErrnoException).code === 'ENOENT') return undefined; throw e; }
}
async function load(files: LocalArtifacts, mode: Mode): Promise<SessionState> {
    const s = await files.read(stateName(mode)) as SessionState;
    if (!s || s.formatVersion !== 1 || s.provider !== 'openlearn' || s.mode !== mode) fail('INVALID_INCREMENTAL_STATE');
    if (s.queryVersion !== queryVersion) fail('INCOMPATIBLE_QUERY_VERSION');
    limits(s.limits);
    for (const key of ['requests','pagesApplied','lastRequestAt','blockedUntil'] as const) {
        if (!Number.isSafeInteger(s[key]) || s[key] < 0) fail('INVALID_INCREMENTAL_STATE');
    }
    if (s.requests > s.limits.maxRequests || s.pagesApplied > s.limits.maxPages || !Array.isArray(s.seen) || s.seen.length > 20
        || !Array.isArray(s.applied) || s.applied.length > 4 || typeof s.exhausted !== 'boolean'
        || s.target !== null && typeof s.target !== 'string' || s.lastError !== null && !/^[A-Z_]+$/.test(s.lastError)
        || mode === 'live' && (typeof s.sourceAuthorization !== 'string' || !/^[a-zA-Z0-9:_-]{8,120}$/.test(s.sourceAuthorization))) fail('INVALID_INCREMENTAL_STATE');
    if (s.initialCursor !== null) resource(s.initialCursor);
    if (s.confirmedCursor !== null) resource(s.confirmedCursor);
    s.seen.forEach(resource);
    if (s.pending && (!/^[a-f0-9-]{36}$/.test(s.pending.runId) || s.pending.file !== `openlearn-${s.pending.runId}.json`
        || new Date(s.pending.observedAt).toISOString() !== s.pending.observedAt
        || s.pending.hash !== null && !/^[a-f0-9]{64}$/.test(s.pending.hash))) fail('INVALID_PENDING_ARTIFACT');
    return s;
}
async function pending(files: LocalArtifacts, s: SessionState): Promise<IncrementalArtifact> {
    if (!s.pending) fail('NO_PENDING_ARTIFACT');
    const a = await optional(files,s.pending.file) as IncrementalArtifact | undefined;
    if (!a) fail('INTERRUPTED_FETCH_REVIEW_REQUIRED');
    if (a.formatVersion !== 1 || a.provider !== 'openlearn' || a.queryVersion !== queryVersion || a.cursorBefore !== s.confirmedCursor
        || a.run?.runId !== s.pending.runId || a.run.observedAt !== s.pending.observedAt || a.run.sourceId !== 'openlearn'
        || a.run.scope !== 'query' || a.run.missingPages !== true || typeof a.advanceAllowed !== 'boolean'
        || !Array.isArray(a.resources) || a.resources.length > s.limits.pageSize || !Array.isArray(a.requests) || a.requests.length > 2
        || !Array.isArray(a.run.candidates) || a.run.candidates.length > 200 || !Array.isArray(a.editorialConflicts)
        || !Array.isArray(a.records) || a.records.length > 200 || typeof a.exhausted !== 'boolean'
        || typeof a.run.quotaLimited !== 'boolean' || !Array.isArray(a.run.errors) || a.run.errors.some(e => typeof e !== 'string' || !/^[A-Z_]+$/.test(e))
        || s.pending.hash !== null && hash(a) !== s.pending.hash) fail('INVALID_PENDING_ARTIFACT');
    a.resources.forEach(resource);
    if (new Set(a.resources).size !== a.resources.length || a.resources.some((id,i) => id <= (a.resources[i-1] ?? a.cursorBefore ?? ''))
        || a.advanceAllowed && (a.run.candidates.length !== a.records.length || a.requests.length !== (a.resources.length ? 2 : 1))
        || !a.advanceAllowed && a.run.candidates.length !== 0) fail('INVALID_PENDING_ARTIFACT');
    timestamp(a.run.observedAt);
    for (const raw of a.run.candidates) {
        const c = normalize(raw,'openlearn',a.run.observedAt);
        if (c.associatedSkills.length || c.language !== null || c.durationMinutes !== null || c.isPaid !== null || c.price != null
            || c.availability !== 'unknown' || c.modality !== 'unknown' || c.geography !== null || c.offerings.length) fail('INVALID_INCREMENTAL_METADATA');
    }
    if (a.advanceAllowed && (a.run.status !== 'partial' || !a.run.valid || a.cursorNext !== (a.resources.at(-1) ?? s.confirmedCursor))
        || !a.advanceAllowed && (a.cursorNext !== s.confirmedCursor || a.run.status !== 'failed' || a.run.valid)) fail('INVALID_PENDING_ARTIFACT');
    return a;
}
export interface SessionDependencies {
    request: typeof fetch; editorialUrls: Set<string>; now?: () => number; sleep?: (ms: number) => Promise<void>; timeoutMs?: number;
}
export async function initialize(root: string, mode: Mode, cursor: string | null, sourceAuthorization: string | null = null,
    options: Limits = { pageSize: 10,maxPages: 1,maxRequests: 2,minIntervalMs: 5000 }) {
    if (cursor !== null) resource(cursor);
    limits(options);
    if (mode === 'live' && (!sourceAuthorization || !/^[a-zA-Z0-9:_-]{8,120}$/.test(sourceAuthorization))) fail('EXPLICIT_SOURCE_AUTHORIZATION_REQUIRED');
    return withDiscoveryStore(root,mode,async (_store,_report,files) => {
        if (await optional(files,stateName(mode)) !== undefined) fail('SESSION_ALREADY_EXISTS');
        const state: SessionState = { formatVersion: 1,provider: 'openlearn',queryVersion,mode,sourceAuthorization,limits: options,
            initialCursor: cursor,confirmedCursor: cursor,requests: 0,pagesApplied: 0,lastRequestAt: 0,blockedUntil: 0,lastError: null,
            pending: null,seen: [],exhausted: false,target: null,applied: [] };
        await files.write(stateName(mode),state); return state;
    });
}
export async function status(root: string, mode: Mode) {
    return withDiscoveryStore(root,mode,async (_s,_r,files) => {
        const s = await load(files,mode);
        let a: IncrementalArtifact | null = null, recovery: string | null = null;
        try { a = s.pending ? await pending(files,s) : null; }
        catch (e) { if (!(e instanceof DiscoveryError) || e.code !== 'INTERRUPTED_FETCH_REVIEW_REQUIRED') throw e; recovery = e.code; }
        return { ...s,recovery,remainingRequests: s.limits.maxRequests - s.requests,prepared: a ? {
            runId: a.run.runId,hash: hash(a),runSha256: hash(a.run),cursorBefore: a.cursorBefore,cursorNext: a.cursorNext,status: a.run.status,
            identities: a.resources.length,repeated: a.resources.filter(id => s.seen.includes(id)).length,
            observations: a.run.candidates.length,rejectedRecords: a.run.valid ? 0 : null,pageRejected: !a.run.valid,errors: a.run.errors,
            editorialConflicts: a.editorialConflicts } : null };
    });
}
export async function fetchPage(root: string, mode: Mode, authorization: string | null, deps: SessionDependencies) {
    return withDiscoveryStore(root,mode,async (_store,_report,files) => {
        const s = await load(files,mode), now = deps.now ?? Date.now;
        if (mode === 'live' && authorization !== s.sourceAuthorization) fail('EXPLICIT_SOURCE_AUTHORIZATION_REQUIRED');
        if (s.pending) return pending(files,s); // Crash after artifact write: recover without another HTTP request.
        if (s.exhausted || s.pagesApplied >= s.limits.maxPages || s.requests + 2 > s.limits.maxRequests) fail('PILOT_BUDGET_EXHAUSTED');
        if (now() < s.blockedUntil) fail('PROVIDER_BACKOFF');
        if (s.lastError !== null) fail('FAILED_PAGE_REVIEW_REQUIRED');
        const runId = randomUUID();
        s.pending = { runId,observedAt: new Date(now()).toISOString(),file: `openlearn-${runId}.json`,hash: null };
        await files.write(stateName(mode),s);
        const reserve = async () => {
            if (s.requests >= s.limits.maxRequests || now() < s.blockedUntil) fail('PILOT_BUDGET_EXHAUSTED');
            const wait = Math.max(0,s.lastRequestAt + s.limits.minIntervalMs - now());
            if (wait) await (deps.sleep ?? (ms => new Promise(resolve => setTimeout(resolve,ms))))(wait);
            if (s.lastRequestAt && now() < s.lastRequestAt + s.limits.minIntervalMs) fail('REQUEST_INTERVAL_NOT_ELAPSED');
            s.requests++; s.lastRequestAt = now(); await files.write(stateName(mode),s);
        };
        let a: IncrementalArtifact;
        try { a = await preparePage({ cursor: s.confirmedCursor,size: s.limits.pageSize,runId,observedAt: s.pending.observedAt },
            deps.request,reserve,deps.editorialUrls,now,deps.timeoutMs); }
        catch (e) {
            if (!(e instanceof PageError)) throw e;
            a = e.artifact; s.lastError = e.code; s.blockedUntil = now() + e.retryAfterMs;
        }
        // Atomic rename: an interrupted file write leaves the intention, never a confirmed cursor.
        await files.write(s.pending.file,a);
        s.pending.hash = hash(a); await files.write(stateName(mode),s);
        return a;
    });
}
export async function applyPage(root: string, mode: Mode, staging: CourseSyncStaging, target: string) {
    if (!/^127\.0\.0\.1:\d+:cvexpert_test_[a-f0-9]{32}:cvexpert_sync_ingest$/.test(target)
        && !/^\[::1\]:\d+:cvexpert_test_[a-f0-9]{32}:cvexpert_sync_ingest$/.test(target)) fail('INVALID_LOCAL_TARGET_IDENTITY');
    return withDiscoveryStore(root,mode,async (_store,_report,files) => {
        const s = await load(files,mode), a = await pending(files,s);
        if (s.target !== null && s.target !== target) fail('SESSION_TARGET_CHANGED');
        s.target = target; s.pending!.hash = hash(a); await files.write(stateName(mode),s);
        const result = await staging.execute(a.run); // Owns snapshot/reconcile/transaction/checkpoint, including uncertain-COMMIT replay.
        if (result.skipped) fail('STAGING_RUN_SKIPPED_REVIEW_REQUIRED');
        const repeated = a.resources.filter(id => s.seen.includes(id)).length;
        s.applied.push({ runId: a.run.runId,hash: hash(a),runSha256: hash(a.run),resources: a.resources.length,repeated,result });
        if (a.advanceAllowed) {
            s.confirmedCursor = a.cursorNext; s.pagesApplied++; s.exhausted = a.exhausted;
            s.seen = [...new Set([...s.seen,...a.resources])];
        } else {
            s.lastError = a.run.errors[0] ?? 'FAILED_PAGE_REVIEW_REQUIRED';
        }
        s.pending = null; await files.write(stateName(mode),s);
        const counts = Object.fromEntries(['insert','update','unchanged','duplicate','invalid','ambiguous','manual_protected']
            .map(kind => [kind,result.actions.filter(action => action.kind === kind).length]));
        return { runId: a.run.runId,hash: hash(a),runSha256: hash(a.run),result,counts,cursor: s.confirmedCursor,repeated,
            remainingRequests: s.limits.maxRequests - s.requests,editorialConflicts: a.editorialConflicts };
    });
}
