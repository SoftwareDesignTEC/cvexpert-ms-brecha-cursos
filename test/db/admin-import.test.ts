import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { test } from 'node:test';
import { Pool } from 'pg';
import { migrate } from '../../src/db/migrate.js';
import { inTransaction } from '../../src/db/transaction.js';
import { importCatalog, planCatalog } from '../../scripts/catalog-import/importer.js';
import { importMarketRequirements, planMarketRequirements } from '../../scripts/market-import/importer.js';
import { planAdministrativeImport, prepareInput } from '../../scripts/admin-import/planner.js';
import { getDatabaseConfig } from '../../src/db/config.js';
import { withTestDatabase } from './helpers/test-database.js';

const catalog = JSON.parse(await readFile(new URL('../fixtures/catalog-import.test.json', import.meta.url), 'utf8'));
const market = JSON.parse(await readFile(new URL('../fixtures/market-import.test.json', import.meta.url), 'utf8'));
const scale = JSON.parse(await readFile(new URL('../fixtures/market-import.test-scale.json', import.meta.url), 'utf8'));

test('planificadores compartidos: READ ONLY real, idempotencia y conflictos', async t => withTestDatabase(async owner => {
    await migrate(owner);
    await owner.query('INSERT INTO public.skills (name) SELECT unnest($1::text[])', [market.records.map((r: any) => r.skillName)]);
    const before = async () => (await owner.query(`SELECT
        (SELECT count(*) FROM public.skills) AS skills, (SELECT count(*) FROM public.courses) AS courses,
        (SELECT count(*) FROM public.course_skills) AS links, (SELECT count(*) FROM public.market_requirements) AS market,
        (SELECT last_value FROM public.skills_id_seq) AS skill_sequence,
        (SELECT last_value FROM public.courses_id_seq) AS course_sequence`)).rows;
    await t.test('propuestas sin DML ni consumo de secuencias; READ ONLY impide escrituras', async () => {
        const snapshot = await before();
        await inTransaction(owner, async client => {
            await client.query('SET TRANSACTION ISOLATION LEVEL REPEATABLE READ, READ ONLY');
            const c = await planCatalog(client, catalog);
            const m = await planMarketRequirements(client, market, scale);
            assert.equal(c.report.courses.filter(r => r.action === 'insert').length, 2);
            assert.equal(m.changes.filter(r => r.action === 'insert').length, 2);
        });
        assert.deepEqual(await before(), snapshot);
        await assert.rejects(inTransaction(owner, async client => {
            await client.query('SET TRANSACTION READ ONLY');
            await client.query("INSERT INTO public.skills(name) VALUES ('TEST-read-only-denied')");
        }), (e: any) => e.code === '25006');
    });
    await importCatalog(owner, catalog, { apply: true });
    await importMarketRequirements(owner, market, scale, { apply: true });
    await t.test('repetición devuelve existentes; conflictos mantienen semántica local', async () => {
        await inTransaction(owner, async client => {
            await client.query('SET TRANSACTION ISOLATION LEVEL REPEATABLE READ, READ ONLY');
            assert.ok((await planCatalog(client, catalog)).report.courses.every(r => r.action === 'unchanged'));
            assert.ok((await planMarketRequirements(client, market, scale)).changes.every(r => r.action === 'unchanged'));
            const conflicting = structuredClone(catalog);
            conflicting.courses[0].title = 'TEST-conflict';
            assert.equal((await planCatalog(client, conflicting)).report.conflicts, 1);
            const stale = structuredClone(market);
            stale.records[0].sourceReference = 'TEST-conflicting-evidence';
            await assert.rejects(planMarketRequirements(client, stale, scale), /posterior/);
        });
    });
    await t.test('sesión completa con TLS local y rol SELECT separado', {
        skip: !process.env.ADMIN_IMPORT_TEST_CA && 'Requiere PostgreSQL local TLS y ADMIN_IMPORT_TEST_CA; ver docs/admin-import.md',
    }, async () => {
        const target = { server: 'test.postgres.database.azure.com', database: String(owner.options.database),
            identity: 'cvexpert_admin_preview_test', port: (await owner.query('SELECT inet_server_port() AS port')).rows[0].port };
        await owner.query('GRANT USAGE ON SCHEMA public TO cvexpert_admin_preview_test');
        await owner.query('GRANT SELECT ON public.skills, public.courses, public.course_skills, public.market_requirements, public.schema_migrations TO cvexpert_admin_preview_test');
        const config = { ...getDatabaseConfig(), database: target.database, user: target.identity,
            password: 'TEST-preview-only', ssl: { rejectUnauthorized: true, servername: target.server,
                ca: await readFile(process.env.ADMIN_IMPORT_TEST_CA!, 'utf8') } };
        // Numeric loopback is deliberate and test-only. Production CLI cannot override the FQDN.
        assert.equal(config.host, '127.0.0.1');
        const reader = new Pool(config);
        const snapshot = await before();
        try {
            const input = prepareInput(catalog, market, scale);
            const report = await planAdministrativeImport(reader, target, input);
            assert.equal(report.mode, 'dry-run');
            assert.equal(report.summary.conflicts, 0);
            assert.equal(report.summary.catalogInserts, 0);
            assert.equal(report.summary.marketExisting, 2);
            assert.equal(report.provenancePersisted, false);
            assert.equal(report.target.certificateVerified, true);
            assert.equal(report.applyAvailable, false);
            assert.deepEqual((await planAdministrativeImport(reader, target, input)).summary, report.summary);
            const additions = structuredClone(input);
            additions.catalog.courses.forEach(c => { c.url = c.url.replace('/test/', '/test/new/'); });
            additions.market.marketKey = 'TEST-new-preview-only';
            additions.market.records.forEach(r => { r.marketKey = additions.market.marketKey; });
            const proposed = await planAdministrativeImport(reader, target, additions);
            assert.equal(proposed.summary.catalogInserts, 5); // Two courses and three associations.
            assert.equal(proposed.summary.marketInserts, 2);
            assert.equal(proposed.market?.changes[0]?.after.sourceReference, input.market.records[0]?.sourceReference);
            assert.deepEqual(await before(), snapshot);
            const conflicting = structuredClone(input);
            conflicting.catalog.courses[0]!.title = 'TEST-conflict';
            conflicting.market.records[0]!.sourceReference = 'TEST-evidence-conflict';
            const rejected = await planAdministrativeImport(reader, target, conflicting);
            assert.equal(rejected.summary.conflicts, 2);
            assert.equal(rejected.market, null);
            assert.ok(rejected.conflicts.some(c => c.scope === 'market'));
            const updated = structuredClone(input);
            updated.market.records[0]!.sourceReference = 'TEST-new-evidence';
            updated.market.records[0]!.observedAt = '2026-02-01T00:00:00.000Z';
            assert.equal((await planAdministrativeImport(reader, target, updated)).summary.marketUpdatesRequiringReview, 1);
            for (const patch of [{ database: 'wrong' }, { identity: 'wrong' }, { identity: 'cvexpert_brecha_app' }]) {
                await assert.rejects(planAdministrativeImport(reader, { ...target, ...patch }, input));
            }
            await owner.query('GRANT INSERT ON public.skills TO cvexpert_admin_preview_test');
            try { await assert.rejects(planAdministrativeImport(reader, target, input), /permisos mínimos/); }
            finally { await owner.query('REVOKE INSERT ON public.skills FROM cvexpert_admin_preview_test'); }
            await owner.query("UPDATE public.schema_migrations SET checksum='TEST-altered' WHERE name LIKE '003%'");
            await assert.rejects(planAdministrativeImport(reader, target, input), /Historial/);
            assert.deepEqual(await before(), snapshot);
        } finally { await reader.end(); }
        const wrongCertificate = new Pool({ ...config, ssl: { ...config.ssl, servername: 'wrong.postgres.database.azure.com' } });
        try { await assert.rejects(planAdministrativeImport(wrongCertificate, target, prepareInput(catalog, market, scale))); }
        finally { await wrongCertificate.end(); }
        const plaintext = new Pool({ ...config, ssl: false });
        try { await assert.rejects(planAdministrativeImport(plaintext, target, prepareInput(catalog, market, scale)), /TLS/); }
        finally { await plaintext.end(); }
    });
}));
