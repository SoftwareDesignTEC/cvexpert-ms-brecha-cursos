import assert from 'node:assert/strict';
import { readFile, mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { generateKeyPairSync, sign } from 'node:crypto';
import dns from 'node:dns';
import { test } from 'node:test';
import { Pool } from 'pg';
import { migrate } from '../../src/db/migrate.js';
import { getDatabaseConfig } from '../../src/db/config.js';
import { withTestDatabase } from './helpers/test-database.js';
import { jointPlan, applyApproved, verifyApproved, CommitUncertainError } from '../../scripts/admin-import/apply.js';
import { proposal, canonical, digest, bytesHash, validateApproval, type Approval, type Bundle } from '../../scripts/admin-import/approval.js';
import { prepareInput, verifySession } from '../../scripts/admin-import/planner.js';
import { runApplyCLI } from '../../scripts/admin-apply.js';

const catalog = JSON.parse(await readFile(new URL('../fixtures/catalog-import.test.json', import.meta.url), 'utf8'));
const market = JSON.parse(await readFile(new URL('../fixtures/market-import.test.json', import.meta.url), 'utf8'));
const scale = JSON.parse(await readFile(new URL('../fixtures/market-import.test-scale.json', import.meta.url), 'utf8'));
// Fixtures exclusivos de pruebas. Nunca se sustituyen por los candidatos privados ni salen de loopback.
catalog.skills.push(...market.records.map((r: any) => r.skillName));
const input = prepareInput(catalog, market, scale);
const keys = generateKeyPairSync('ed25519');
const publicPem = keys.publicKey.export({ type: 'spki', format: 'pem' }).toString();
const fingerprint = bytesHash(keys.publicKey.export({ type: 'spki', format: 'der' }));

// La suite CI prepara TLS y dos LOGIN limitados; no existe modo inseguro en la CLI.
test('aplicación coordinada real PostgreSQL 17 + TLS', {
    skip: !process.env.ADMIN_IMPORT_TEST_CA && 'Preparar PostgreSQL 17 TLS e identidades según docs/admin-import.md',
}, async t => withTestDatabase(async owner => {
    assert.match((await owner.query('SHOW server_version')).rows[0].server_version, /^17\./);
    await migrate(owner);
    const target = { server: 'test.postgres.database.azure.com', database: String(owner.options.database),
        port: (await owner.query('SELECT inet_server_port() AS p')).rows[0].p, identity: 'cvexpert_admin_apply_test' };
    const readerTarget = { ...target, identity: 'cvexpert_admin_preview_test' };
    await owner.query('GRANT USAGE ON SCHEMA public TO cvexpert_admin_apply_test, cvexpert_admin_preview_test');
    await owner.query(`GRANT SELECT ON public.skills,public.courses,public.course_skills,public.market_requirements,
        public.schema_migrations,public.admin_import_runs TO cvexpert_admin_apply_test,cvexpert_admin_preview_test`);
    await owner.query('GRANT INSERT ON public.skills,public.courses,public.course_skills,public.market_requirements,public.admin_import_runs TO cvexpert_admin_apply_test');
    await owner.query('GRANT USAGE ON SEQUENCE public.skills_id_seq,public.courses_id_seq TO cvexpert_admin_apply_test');
    await owner.query('GRANT EXECUTE ON FUNCTION public.lock_admin_import_tables() TO cvexpert_admin_apply_test');
    const config = { ...getDatabaseConfig(), database: target.database, user: target.identity, password: 'TEST-apply-only',
        ssl: { rejectUnauthorized: true, servername: target.server, ca: await readFile(process.env.ADMIN_IMPORT_TEST_CA!, 'utf8') } };
    assert.equal(config.host, '127.0.0.1');
    const writer = new Pool(config), reader = new Pool({ ...config, user: readerTarget.identity, password: 'TEST-preview-only' });
    const bundle: Bundle = { input, files: { catalog: digest(catalog), market: digest(market), scale: digest(scale), evidence: digest('TEST-only') } };
    const approve = async (value = input, updateReview = false) => {
        const c = await reader.connect();
        try {
            await c.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
            await verifySession(c, readerTarget);
            const p = proposal(target, readerTarget.identity, { ...bundle, input: value }, await jointPlan(c, value));
            await c.query('COMMIT');
            p.approvedAt = new Date(Date.now() - 1000).toISOString(); p.expiresAt = new Date(Date.now() + 3600000).toISOString();
            p.reviewer = 'TEST approver'; p.ticket = 'TEST-approval';
            p.review = { sources: true, editorialLevels: true, freshness: true, authorizeWrites: true, marketUpdates: updateReview };
            return { payload: p, signature: sign(null, Buffer.from(canonical(p)), keys.privateKey).toString('base64') };
        } catch (e) { await c.query('ROLLBACK'); throw e; } finally { c.release(); }
    };
    const counts = async () => (await owner.query(`SELECT (SELECT count(*) FROM public.skills) AS skills,
        (SELECT count(*) FROM public.courses) AS courses,(SELECT count(*) FROM public.course_skills) AS links,
        (SELECT count(*) FROM public.market_requirements) AS market,(SELECT count(*) FROM public.admin_import_runs) AS runs`)).rows[0];
    try {
        let first: Approval;
        await t.test('primera carga en vacío, habilidades nuevas, asociaciones y mercado en un COMMIT', async () => {
            first = await approve();
            validateApproval(first, publicPem, fingerprint, bundle);
            assert.equal(first.payload.plan.market.changes.length, 2);
            const result = await applyApproved(writer, first, input);
            assert.equal(result.status, 'applied'); assert.equal(result.replay, false);
            assert.deepEqual(await counts(), { skills: '4', courses: '2', links: '3', market: '2', runs: '1' });
            assert.equal((await verifyApproved(reader, readerTarget, first, input)).status, 'applied');
            assert.equal((await owner.query('SELECT duration_hours FROM public.courses WHERE url=$1', [catalog.courses[0].url])).rows[0].duration_hours, null);
        });
        await t.test('repetición idéntica y lote nuevo sin cambios no duplican filas', async () => {
            const before = await counts();
            assert.equal((await applyApproved(writer, first!, input)).replay, true);
            assert.deepEqual(await counts(), before);
            const next = await approve();
            await applyApproved(writer, next, input);
            assert.deepEqual(await counts(), { ...before, runs: '2' });
        });
        await t.test('conflictos de curso y escala, fechas, niveles y demo se rechazan', async () => {
            const changed = structuredClone(input); changed.catalog.courses[0]!.title = 'TEST-conflict';
            await assert.rejects(approve(changed), /Conflicto/);
            // La transacción de approve fallida termina al liberar? ROLLBACK explícito en helper abajo.
            const badScale = structuredClone(input); badScale.scale.key = 'TEST-other';
            badScale.market.records.forEach(r => { r.scaleKey = badScale.scale.key; });
            await assert.rejects(approve(badScale), /escala/);
            for (const patch of [{ observedAt: '2026-02-30T00:00:00.000Z' }, { requiredLevel: 999 }, { dataKind: 'demo' }]) {
                const invalid = structuredClone(input); Object.assign(invalid.market.records[0]!, patch);
                assert.throws(() => prepareInput(invalid.catalog, invalid.market, invalid.scale));
            }
        });
        await t.test('identidad real, permisos insuficientes y rol HTTP', async () => {
            await assert.rejects(applyApproved(reader, await approve(), input), /permisos mínimos/);
            await owner.query('REVOKE INSERT ON public.courses FROM cvexpert_admin_apply_test');
            try { await assert.rejects(applyApproved(writer, await approve(), input), /Permisos administrativos/); }
            finally { await owner.query('GRANT INSERT ON public.courses TO cvexpert_admin_apply_test'); }
            await assert.rejects(applyApproved(writer, { ...first!, payload: { ...first!.payload, target: { ...target, identity: 'cvexpert_brecha_app' } } }, input));
            await owner.query('GRANT UPDATE ON public.courses TO cvexpert_admin_apply_test');
            try { await assert.rejects(applyApproved(writer, await approve(), input), /Permisos administrativos/); }
            finally { await owner.query('REVOKE UPDATE ON public.courses FROM cvexpert_admin_apply_test'); }
        });
        await t.test('fallo SQL después de catálogo revierte catálogo, mercado y auditoría completos', async () => {
            const value = structuredClone(input); value.catalog.skills.push('[TEST] rollback');
            value.catalog.courses.forEach(c => { c.url += '/rollback'; });
            value.market.marketKey += '-rollback'; value.market.records.forEach(r => { r.marketKey = value.market.marketKey; });
            const approval = await approve(value), before = await counts();
            await owner.query(`CREATE FUNCTION public.test_reject_market() RETURNS trigger LANGUAGE plpgsql AS $$
                BEGIN RAISE EXCEPTION 'TEST fault after catalog'; END; $$;
                CREATE TRIGGER test_reject_market BEFORE INSERT ON public.market_requirements FOR EACH ROW EXECUTE FUNCTION public.test_reject_market()`);
            try { await assert.rejects(applyApproved(writer, approval, value), /TEST fault/); }
            finally { await owner.query('DROP TRIGGER test_reject_market ON public.market_requirements; DROP FUNCTION public.test_reject_market()'); }
            assert.deepEqual(await counts(), before);
            assert.equal((await verifyApproved(reader, readerTarget, approval, value)).status, 'not-applied');
        });
        await t.test('concurrencia: mismo UUID aplica una vez; planes distintos obsoletos se rechazan', async () => {
            const a = await approve();
            const results = await Promise.all([applyApproved(writer, a, input), applyApproved(writer, a, input)]);
            assert.deepEqual(results.map(r => r.replay).sort(), [false, true]);
            const value = structuredClone(input); value.catalog.skills.push('[TEST] concurrent');
            const b = await approve(value), c = await approve(value);
            const results2 = await Promise.allSettled([applyApproved(writer, b, value), applyApproved(writer, c, value)]);
            assert.equal(results2.filter(r => r.status === 'fulfilled').length, 1);
            assert.equal(results2.filter(r => r.status === 'rejected').length, 1);
        });
        await t.test('cambios de archivos, firma, destino y estado entre revisión y ejecución', async () => {
            const a = await approve();
            assert.throws(() => validateApproval(a, publicPem, fingerprint, { ...bundle, files: { ...bundle.files, evidence: digest('changed') } }));
            const tampered = structuredClone(a); tampered.payload.target.database = 'wrong';
            assert.throws(() => validateApproval(tampered, publicPem, fingerprint, bundle));
            assert.throws(() => validateApproval(a, publicPem, '0'.repeat(64), bundle));
            await owner.query('UPDATE public.courses SET title=$1 WHERE url=$2', ['TEST drift', catalog.courses[0].url]);
            try { await assert.rejects(applyApproved(writer, a, input), /Conflicto/); }
            finally { await owner.query('UPDATE public.courses SET title=$1 WHERE url=$2', [catalog.courses[0].title, catalog.courses[0].url]); }
        });
        await t.test('updates requieren before/after firmado y autorización explícita', async () => {
            const value = structuredClone(input);
            value.market.records[0]!.observedAt = '2026-03-01T00:00:00.000Z'; value.market.records[0]!.requiredLevel = null;
            await assert.rejects(applyApproved(writer, await approve(value), value), /no autorizadas/);
            await owner.query('GRANT UPDATE(scale_key,required_level,source_reference,observed_at,data_kind) ON public.market_requirements TO cvexpert_admin_apply_test');
            try { await applyApproved(writer, await approve(value, true), value); }
            finally {
                await owner.query('REVOKE UPDATE(scale_key,required_level,source_reference,observed_at,data_kind) ON public.market_requirements FROM cvexpert_admin_apply_test');
                const r = input.market.records[0]!;
                await owner.query('UPDATE public.market_requirements SET observed_at=$1,required_level=$2 WHERE market_key=$3 AND skill_id=(SELECT id FROM public.skills WHERE name=$4)',
                    [r.observedAt, r.requiredLevel, r.marketKey, r.skillName]);
            }
        });
        await t.test('COMMIT confirmado en servidor con respuesta perdida: reconciliar y reintentar sin duplicar', async () => {
            const value = structuredClone(input); value.catalog.skills.push('[TEST] commit uncertain');
            const a = await approve(value), before = await counts();
            const uncertain = new Pool(config);
            const original = uncertain.connect.bind(uncertain);
            t.mock.method(uncertain, 'connect', async () => {
                const client = await original(), query = client.query.bind(client);
                t.mock.method(client, 'query', async (...args: any[]) => {
                    const result = await (query as any)(...args);
                    if (args[0] === 'COMMIT') throw new Error('TEST transport dropped COMMIT response');
                    return result;
                });
                return client;
            });
            try { await assert.rejects(applyApproved(uncertain, a, value), CommitUncertainError); }
            finally { await uncertain.end(); }
            assert.equal((await verifyApproved(reader, readerTarget, a, value)).status, 'applied');
            assert.equal((await applyApproved(writer, a, value)).replay, true);
            assert.deepEqual(await counts(), { ...before, skills: String(Number(before.skills) + 1), runs: String(Number(before.runs) + 1) });
        });
        await t.test('conexión perdida antes de COMMIT: no-aplicado y reintento seguro', async () => {
            const a = await approve();
            const uncertain = new Pool(config), original = uncertain.connect.bind(uncertain);
            t.mock.method(uncertain, 'connect', async () => {
                const c = await original(), query = c.query.bind(c);
                t.mock.method(c, 'query', async (...args: any[]) => {
                    if (args[0] === 'COMMIT') { await query('ROLLBACK'); throw new Error('TEST disconnected before COMMIT'); }
                    return (query as any)(...args);
                }); return c;
            });
            try { await assert.rejects(applyApproved(uncertain, a, input), CommitUncertainError); }
            finally { await uncertain.end(); }
            assert.equal((await verifyApproved(reader, readerTarget, a, input)).status, 'not-applied');
            await applyApproved(writer, a, input);
        });
        await t.test('TLS obligatorio y CA incorrecta fallan antes del DML', async () => {
            const a = await approve();
            for (const ssl of [false, { ...config.ssl, servername: 'wrong.postgres.database.azure.com' }]) {
                const bad = new Pool({ ...config, ssl });
                try { await assert.rejects(applyApproved(bad, a, input)); } finally { await bad.end(); }
            }
        });
        await t.test('CLI real plan → revisión → firma → apply → verify, recibo durable y archivos exactos', async () => {
            const dir = await mkdtemp(join(tmpdir(), 'cvexpert-apply-cli-'));
            const lookup = dns.lookup.bind(dns);
            // DNS de prueba exclusivamente en este proceso; CLI productiva no admite override.
            const mock = t.mock.method(dns, 'lookup', ((host: string, ...args: any[]) => (lookup as any)(host === target.server ? '127.0.0.1' : host, ...args)) as any);
            try {
                const files = { catalog, market, scale, evidence: 'TEST-only', target, 'reader-target': readerTarget };
                for (const [name,v] of Object.entries(files)) await writeFile(join(dir,name), name === 'evidence' ? String(v) : JSON.stringify(v));
                const base = ['catalog','market','scale','evidence'].flatMap(k => [`--${k}`, join(dir,k)]);
                const env = (identity: string, password: string) => ({ ADMIN_IMPORT_SERVER: target.server, ADMIN_IMPORT_PORT: String(target.port),
                    ADMIN_IMPORT_DATABASE: target.database, ADMIN_IMPORT_IDENTITY: identity, ADMIN_IMPORT_PASSWORD: password,
                    ADMIN_IMPORT_CA_FILE: process.env.ADMIN_IMPORT_TEST_CA, ADMIN_IMPORT_APPROVER_KEY_SHA256: fingerprint });
                await runApplyCLI(['plan',...base,'--target',join(dir,'target'),'--reader-target',join(dir,'reader-target'),'--output',join(dir,'proposal')],env(readerTarget.identity,'TEST-preview-only'));
                const p = JSON.parse(await readFile(join(dir,'proposal'),'utf8'));
                assert.equal(p.review.authorizeWrites,false);
                p.approvedAt = new Date(Date.now()-1000).toISOString(); p.expiresAt = new Date(Date.now()+3600000).toISOString();
                p.reviewer='TEST approver'; p.ticket='TEST-CLI';
                Object.assign(p.review,{ sources:true, editorialLevels:true, freshness:true, authorizeWrites:true });
                await writeFile(join(dir,'proposal'),JSON.stringify(p));
                await writeFile(join(dir,'private'),keys.privateKey.export({type:'pkcs8',format:'pem'}));
                await writeFile(join(dir,'public'),publicPem);
                await runApplyCLI(['sign','--proposal',join(dir,'proposal'),'--private-key',join(dir,'private'),'--output',join(dir,'approval')],{});
                const applyArgs = [...base,'--approval',join(dir,'approval'),'--public-key',join(dir,'public'),'--receipt',join(dir,'receipt')];
                assert.equal((await runApplyCLI(['apply',...applyArgs],env(target.identity,'TEST-apply-only'))).status,'applied');
                assert.equal((await runApplyCLI(['verify',...applyArgs,'--reader-target',join(dir,'reader-target')],env(readerTarget.identity,'TEST-preview-only'))).status,'applied');
                assert.match(await readFile(join(dir,'receipt'),'utf8'),/"status":"applied"/);
                await writeFile(join(dir,'catalog'),JSON.stringify(catalog)+' ');
                await assert.rejects(runApplyCLI(['apply',...applyArgs],env(target.identity,'TEST-apply-only')),/archivos diferentes/);
            } finally { mock.mock.restore(); await rm(dir,{recursive:true}); }
        });
    } finally { await writer.end(); await reader.end(); }
}));
