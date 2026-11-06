import { createPrivateKey, createPublicKey, sign } from 'node:crypto';
import { open, readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { Pool } from 'pg';
import { readJsonFile } from './import-market.js';
import { administrativeConfig, applicationConfig, parseTarget, AdminImportError } from './admin-import/config.js';
import { verifySession } from './admin-import/planner.js';
import { applyApproved, verifyApproved, jointPlan, CommitUncertainError } from './admin-import/apply.js';
import { bytesHash, canonical, loadBundle, proposal, validateApproval, type Approval, type Proposal } from './admin-import/approval.js';

export function argumentsFor(args: string[]) {
    const [command, ...rest] = args;
    const required: Record<string, string[]> = {
        plan: ['catalog','market','scale','evidence','target','reader-target','output'],
        sign: ['proposal','private-key','output'],
        apply: ['catalog','market','scale','evidence','approval','public-key','receipt'],
        verify: ['catalog','market','scale','evidence','approval','public-key','receipt','reader-target'],
    };
    if (!command || !required[command]) throw new AdminImportError('Usar plan, sign, apply o verify.');
    const paths: Record<string, string> = {};
    for (let i = 0; i < rest.length; i += 2) {
        const k = rest[i]?.slice(2), v = rest[i + 1];
        if (!rest[i]?.startsWith('--') || !k || !required[command]!.includes(k) || paths[k] || !v || v.startsWith('--')) {
            throw new AdminImportError('Opción ausente, repetida o desconocida.');
        }
        paths[k] = v;
    }
    if (Object.keys(paths).length !== required[command]!.length) throw new AdminImportError('Faltan archivos requeridos.');
    // No permitir que salida/recibo destruya un archivo de entrada.
    for (const output of ['output','receipt']) if (paths[output] && Object.entries(paths).some(([k,v]) => k !== output && resolve(v) === resolve(paths[output]!))) {
        throw new AdminImportError('Salida coincide con entrada.');
    }
    return { command, paths };
}
async function writeNew(path: string, value: unknown) {
    const f = await open(path, 'wx', 0o600);
    try { await f.writeFile(JSON.stringify(value, null, 2) + '\n'); await f.sync(); }
    finally { await f.close(); }
}
export async function runApplyCLI(args: string[], env = process.env) {
    const { command, paths } = argumentsFor(args);
    if (command === 'sign') {
        // Operación offline del aprobador. Nunca rellena las decisiones de revisión.
        const payload = await readJsonFile(paths.proposal!) as Proposal;
        const key = createPrivateKey(await readFile(paths['private-key']!, 'utf8'));
        const publicKey = createPublicKey(key).export({ type: 'spki', format: 'pem' }).toString();
        if (key.asymmetricKeyType !== 'ed25519' || !payload.review?.authorizeWrites || !payload.review.sources
            || !payload.review.editorialLevels || !payload.review.freshness || !payload.reviewer || !payload.ticket
            || !payload.approvedAt || !payload.expiresAt) throw new AdminImportError('Completar revisión explícita antes de firmar.');
        const approval = { payload, signature: sign(null, Buffer.from(canonical(payload)), key).toString('base64') };
        await writeNew(paths.output!, approval);
        return { status: 'signed', approverKeySha256: bytesHash(createPublicKey(publicKey).export({ type: 'spki', format: 'der' })) };
    }
    const bundle = await loadBundle(paths);
    if (command === 'plan') {
        const target = parseTarget(await readJsonFile(paths.target!));
        const reader = parseTarget(await readJsonFile(paths['reader-target']!));
        if (reader.identity === target.identity || reader.server !== target.server || reader.database !== target.database || reader.port !== target.port) {
            throw new AdminImportError('Requiere lector separado en el mismo destino.');
        }
        const pool = new Pool(administrativeConfig(reader, env));
        pool.on('error', () => {});
        try {
            const client = await pool.connect();
            try {
                await client.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
                await verifySession(client, reader);
                const plan = await jointPlan(client, bundle.input);
                await client.query('COMMIT');
                await writeNew(paths.output!, proposal(target, reader.identity, bundle, plan));
                return { status: 'proposal-created', authorized: false };
            } catch (e) { await client.query('ROLLBACK').catch(() => {}); throw e; }
            finally { client.release(); }
        } finally { await pool.end(); }
    }
    const approval = await readJsonFile(paths.approval!) as Approval;
    const p = validateApproval(approval, await readFile(paths['public-key']!, 'utf8'), env.ADMIN_IMPORT_APPROVER_KEY_SHA256 ?? '', bundle, command === 'apply');
    const target = command === 'verify' ? parseTarget(await readJsonFile(paths['reader-target']!)) : p.target;
    if (command === 'verify' && (target.server !== p.target.server || target.database !== p.target.database
        || target.port !== p.target.port || target.identity !== p.readerIdentity)) throw new AdminImportError('Lector no coincide con la aprobación.');
    // Un recibo append-only fsync antes de conectar: evidencia local incluso si COMMIT pierde respuesta.
    const receipt = await open(paths.receipt!, 'a', 0o600);
    const record = async (status: string, extra: object = {}) => {
        const row = { status, executionId: p.executionId, at: new Date().toISOString(), ...extra };
        await receipt.writeFile(JSON.stringify(row) + '\n'); await receipt.sync(); return row;
    };
    let result: Awaited<ReturnType<typeof applyApproved>> | Awaited<ReturnType<typeof verifyApproved>> | undefined;
    try {
        await record('started', { approvalSha256: bytesHash(canonical(approval)), target });
        const pool = new Pool(command === 'apply' ? applicationConfig(target, env) : administrativeConfig(target, env));
        pool.on('error', () => {});
        try {
            result = command === 'apply' ? await applyApproved(pool, approval, bundle.input)
                : await verifyApproved(pool, target, approval, bundle.input);
            await record(result.status, result);
            return result;
        } finally { await pool.end(); }
    } catch (e) {
        await record(result?.status === 'applied' ? 'applied-receipt-error' : e instanceof CommitUncertainError ? 'commit-uncertain' : 'rejected');
        throw e;
    } finally { await receipt.close(); }
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
    runApplyCLI(process.argv.slice(2)).then(r => console.log(JSON.stringify(r, null, 2))).catch(e => {
        console.error(e instanceof CommitUncertainError ? 'COMMIT incierto. Ejecutar db:admin:verify con la misma aprobación.'
            : 'Operación rechazada. Revisar aprobación, archivos, plan, identidad, TLS y permisos; no se publican errores SQL ni credenciales.');
        process.exitCode = e instanceof CommitUncertainError ? 3 : 1;
    });
}
