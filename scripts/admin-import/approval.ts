import { createHash, createPublicKey, verify, randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { readJsonFile } from '../import-market.js';
import { AdminImportError, parseTarget, type Target } from './config.js';
import { prepareInput, type PreparedInput } from './planner.js';
import type { JointPlan } from './apply.js';

export const canonical = (v: unknown): string => {
    if (v instanceof Date) return JSON.stringify(v.toISOString());
    if (Array.isArray(v)) return `[${v.map(canonical).join(',')}]`;
    if (v !== null && typeof v === 'object') return `{${Object.entries(v).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0)
        .map(([k, x]) => `${JSON.stringify(k)}:${canonical(x)}`).join(',')}}`;
    return JSON.stringify(v);
};
export const bytesHash = (v: string | Buffer) => createHash('sha256').update(v).digest('hex');
export const digest = (v: unknown) => bytesHash(canonical(v));
export interface Bundle { input: PreparedInput; files: Record<string, string> }
export interface Proposal {
    formatVersion: 1; executionId: string; target: Target; readerIdentity: string;
    files: Record<string, string>; inputSha256: string; plan: JointPlan; planSha256: string;
    approvedAt: string; expiresAt: string; reviewer: string; ticket: string;
    review: { sources: boolean; editorialLevels: boolean; freshness: boolean; authorizeWrites: boolean; marketUpdates: boolean };
}
export interface Approval { payload: Proposal; signature: string }
export async function loadBundle(paths: Record<string, string>): Promise<Bundle> {
    const values: Record<string, unknown> = {}, files: Record<string, string> = {};
    for (const name of ['catalog', 'market', 'scale', 'evidence']) {
        // Hash de bytes, además del hash semántico; rechaza cambios incluso de formato.
        const before = await readFile(paths[name]!);
        if (before.length > 1024 * 1024) throw new AdminImportError('Archivo demasiado grande.');
        if (name !== 'evidence') values[name] = await readJsonFile(paths[name]!);
        const after = await readFile(paths[name]!);
        if (!before.equals(after)) throw new AdminImportError('Archivo cambió durante lectura.');
        files[name] = bytesHash(before);
    }
    return { input: prepareInput(values.catalog, values.market, values.scale), files };
}
export function proposal(target: Target, readerIdentity: string, bundle: Bundle, plan: JointPlan): Proposal {
    return { formatVersion: 1, executionId: randomUUID(), target: parseTarget(target), readerIdentity,
        files: bundle.files, inputSha256: digest(bundle.input), plan, planSha256: digest(plan),
        approvedAt: '', expiresAt: '', reviewer: '', ticket: '',
        review: { sources: false, editorialLevels: false, freshness: false, authorizeWrites: false, marketUpdates: false } };
}
export function validateApproval(value: Approval, publicKey: string, fingerprint: string, bundle: Bundle, checkExpiry = true): Proposal {
    const key = createPublicKey(publicKey);
    if (key.asymmetricKeyType !== 'ed25519' || bytesHash(key.export({ type: 'spki', format: 'der' })) !== fingerprint
        || !verify(null, Buffer.from(canonical(value.payload)), key, Buffer.from(value.signature, 'base64'))) {
        throw new AdminImportError('Firma o clave del aprobador inválida.');
    }
    const p = value.payload;
    parseTarget(p.target);
    if (p.formatVersion !== 1 || !/^[a-f0-9-]{36}$/.test(p.executionId)
        || !p.readerIdentity || p.readerIdentity === p.target.identity || !p.reviewer.trim() || !p.ticket.trim()
        || [p.review.sources, p.review.editorialLevels, p.review.freshness, p.review.authorizeWrites].some(v => v !== true)
        || typeof p.review.marketUpdates !== 'boolean'
        || !Number.isFinite(Date.parse(p.approvedAt)) || !Number.isFinite(Date.parse(p.expiresAt))
        || Date.parse(p.expiresAt) <= Date.parse(p.approvedAt) || Date.parse(p.approvedAt) > Date.now()
        || (checkExpiry && Date.parse(p.expiresAt) <= Date.now())
        || digest(p.files) !== digest(bundle.files) || p.inputSha256 !== digest(bundle.input)
        || p.planSha256 !== digest(p.plan)) throw new AdminImportError('Aprobación incompleta, vencida o archivos diferentes.');
    return p;
}
