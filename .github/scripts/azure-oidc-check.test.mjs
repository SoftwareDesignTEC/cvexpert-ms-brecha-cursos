import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { checkAccess, checkPreflight, diagnosticResult, validateVariables } from './azure-oidc-check.mjs';

const env = {
    AZURE_CLIENT_ID: 'c7ca60cb-216c-4a31-993b-618ad3bb0923',
    AZURE_TENANT_ID: '22222222-2222-2222-2222-222222222222',
    AZURE_SUBSCRIPTION_ID: '33333333-3333-3333-3333-333333333333',
    AZURE_BACKEND_NETWORK_MODEL: 'public-mtls',
};
const siteId = `/subscriptions/${env.AZURE_SUBSCRIPTION_ID}/resourceGroups/rg-cvexpert/providers/Microsoft.Web/sites/cvexpert-ms-brecha-cursos`;

test('network model must be exactly the real public-mtls value before any Azure or preflight invocation', () => {
    for (const value of [undefined, null, '', 'private', 'PUBLIC-MTLS', ' public-mtls', 'public-mtls ', false]) {
        const invalid = { ...env, AZURE_BACKEND_NETWORK_MODEL: value };
        for (const check of [validateVariables, checkAccess, checkPreflight]) {
            let invoked = false;
            assert.throws(() => check(invalid, () => { invoked = true; }), /Error de configuración de variables: AZURE_BACKEND_NETWORK_MODEL/);
            assert.equal(invoked, false);
        }
    }
    assert.doesNotThrow(() => validateVariables(env));
});

test('a valid UUID for another client cannot pass the deployment identity allowlist', () => {
    for (const value of ['11111111-1111-1111-1111-111111111111', env.AZURE_TENANT_ID, env.AZURE_SUBSCRIPTION_ID]) {
        for (const check of [validateVariables, checkAccess, checkPreflight]) {
            let invoked = false;
            assert.throws(() => check({ ...env, AZURE_CLIENT_ID: value }, () => { invoked = true; }), error => {
                assert.match(error.message, /AZURE_CLIENT_ID no corresponde/);
                assert.ok(!error.message.includes(value));
                return true;
            });
            assert.equal(invoked, false);
        }
    }
    // UUID comparison is case-insensitive; network model comparison is deliberately exact.
    assert.doesNotThrow(() => validateVariables({ ...env, AZURE_CLIENT_ID: env.AZURE_CLIENT_ID.toUpperCase() }));
});

test('configuration CLI exits unsuccessfully before login for invalid model or unexpected client', () => {
    for (const overrides of [{ AZURE_BACKEND_NETWORK_MODEL: '' }, { AZURE_BACKEND_NETWORK_MODEL: 'private' },
        { AZURE_CLIENT_ID: '11111111-1111-1111-1111-111111111111' }]) {
        const result = spawnSync(process.execPath, [fileURLToPath(new URL('./azure-oidc-check.mjs', import.meta.url)), 'configuration'],
            { env: { ...process.env, ...env, ...overrides }, encoding: 'utf8' });
        assert.equal(result.status, 1);
        assert.equal(result.stdout, '');
        assert.match(result.stderr, /Error de configuración de variables/);
    }
});

test('missing or malformed identity variables fail without exposing values or calling Azure', () => {
    assert.doesNotThrow(() => validateVariables(env));
    for (const name of Object.keys(env)) {
        for (const value of [undefined, '', 'sensitive-value', ' ' + env[name]]) {
            assert.throws(() => checkAccess({ ...env, [name]: value }, () => assert.fail('Azure called')), error => {
                assert.match(error.message, /Error de configuración de variables/);
                assert.ok(!error.message.includes('sensitive-value'));
                return true;
            });
        }
    }
});

test('access checks only read the expected account and exact site resource ID', () => {
    const calls = [];
    checkAccess(env, (command, args, options) => {
        calls.push([command, args]);
        assert.deepEqual(options.stdio, ['ignore', 'pipe', 'pipe']);
        return JSON.stringify(calls.length === 1 ? { id: env.AZURE_SUBSCRIPTION_ID, tenantId: env.AZURE_TENANT_ID } : siteId.toUpperCase());
    });
    assert.equal(calls.length, 2);
    assert.deepEqual(calls.map(([cmd, args]) => [cmd, ...args.slice(0, 2)]), [['az', 'account', 'show'], ['az', 'webapp', 'show']]);
    assert.ok(calls[1][1].includes(env.AZURE_SUBSCRIPTION_ID));
});

test('wrong account, tenant, resource, malformed JSON and CLI failures fail closed with sanitized errors', () => {
    for (const account of [{}, null, { id: env.AZURE_CLIENT_ID, tenantId: env.AZURE_TENANT_ID },
        { id: env.AZURE_SUBSCRIPTION_ID, tenantId: env.AZURE_CLIENT_ID }]) {
        assert.throws(() => checkAccess(env, () => JSON.stringify(account)), /Error de permisos o acceso/);
    }
    for (const site of [null, {}, siteId + '/slots/other', siteId.replace('rg-cvexpert', 'other')]) {
        let count = 0;
        assert.throws(() => checkAccess(env, () => JSON.stringify(++count === 1
            ? { id: env.AZURE_SUBSCRIPTION_ID, tenantId: env.AZURE_TENANT_ID } : site)), /Error de permisos o acceso/);
    }
    for (const execute of [() => 'sensitive-invalid-json', () => { throw new Error('sensitive-token'); }]) {
        assert.throws(() => checkAccess(env, execute), error => !error.message.includes('sensitive') && /permisos o acceso/.test(error.message));
    }
});

test('preflight runs existing script with validated unchanged network model and captures all output', () => {
    checkPreflight(env, (command, args, options) => {
        assert.equal(command, process.execPath);
        assert.equal(args.length, 1);
        assert.match(args[0], /azure-preflight\.mjs$/);
        assert.equal(options.env.AZURE_BACKEND_NETWORK_MODEL, 'public-mtls');
        assert.deepEqual(options.env, env);
        assert.deepEqual(options.stdio, ['ignore', 'pipe', 'pipe']);
        return 'sensitive-output';
    });
    for (const [stderr, kind] of [
        ['A required read-only Azure query failed. Check target, login and scoped permissions.\n', 'access'],
        ['sensitive-token-or-certificate', 'preflight'],
    ]) {
        assert.throws(() => checkPreflight(env, () => { throw { stderr }; }), error => {
            assert.equal(error.kind, kind);
            assert.ok(!error.message.includes('sensitive'));
            return true;
        });
    }
});

test('summary distinguishes all required results and never reports skipped or cancelled work as completed', () => {
    const success = Object.fromEntries(['CONFIGURATION', 'LOGIN', 'ACCESS', 'PREFLIGHT'].map(key => [`${key}_OUTCOME`, 'success']));
    assert.match(diagnosticResult(success), /Diagnóstico completado/);
    for (const [key, message] of [['CONFIGURATION', /configuración de variables/], ['LOGIN', /autenticación OIDC/],
        ['ACCESS', /permisos o acceso/], ['PREFLIGHT', /Fallo de preflight/]]) {
        assert.match(diagnosticResult({ ...success, [`${key}_OUTCOME`]: 'failure' }), message);
        for (const outcome of ['', 'skipped', 'cancelled']) {
            assert.match(diagnosticResult({ ...success, [`${key}_OUTCOME`]: outcome }), /incompleto/);
        }
    }
    assert.match(diagnosticResult({ ...success, PREFLIGHT_OUTCOME: 'failure', PREFLIGHT_FAILURE_KIND: 'access' }), /permisos o acceso/);
});

test('manual workflow gates OIDC on main, uses exact environment and narrowly scoped permissions', () => {
    const workflow = readFileSync(new URL('../workflows/azure-oidc-check.yml', import.meta.url), 'utf8');
    const production = readFileSync(new URL('../workflows/ci-cd.yml', import.meta.url), 'utf8');
    assert.match(workflow, /\non:\n  workflow_dispatch:\n\npermissions:\n  contents: read\n/);
    const [guard, diagnostic] = workflow.split('\n  diagnostic:');
    assert.doesNotMatch(guard, /id-token|azure\/login|environment:/);
    assert.match(guard, /\[ "\$GITHUB_EVENT_NAME" != workflow_dispatch \] \|\| \[ "\$GITHUB_REF" != refs\/heads\/main \]/);
    assert.match(guard, /exit 1/);
    assert.match(diagnostic, /needs: branch-guard\n    if: github.event_name == 'workflow_dispatch' && github.ref == 'refs\/heads\/main'/);
    assert.match(diagnostic, /environment: azure-production\n/);
    assert.match(diagnostic, /permissions:\n      contents: read\n      id-token: write\n/);
    assert.equal((workflow.match(/id-token: write/g) ?? []).length, 1);
    assert.equal((workflow.match(/runs-on: ubuntu-24\.04/g) ?? []).length, 2);
    assert.doesNotMatch(workflow, /AZURE_DEPLOY_RUNNER|ENABLE_AZURE_DEPLOY|\bsecrets\./);
    assert.match(diagnostic, /AZURE_BACKEND_NETWORK_MODEL: \$\{\{ vars\.AZURE_BACKEND_NETWORK_MODEL \}\}/);
    const actions = [...workflow.matchAll(/uses: ([^\n]+)/g)].map(match => match[1]);
    assert.equal(actions.length, 3);
    for (const action of actions) {
        assert.match(action, /@[a-f0-9]{40} # v\d+$/);
        assert.ok(production.includes(`uses: ${action}`));
    }
    assert.match(workflow, /persist-credentials: false/);
    assert.ok(workflow.indexOf('id: configuration') < workflow.indexOf('uses: azure/login@'));
    const configurationStep = workflow.slice(workflow.indexOf('id: configuration'), workflow.indexOf('- name: Authenticate with OIDC'));
    assert.match(configurationStep, /node \.github\/scripts\/azure-oidc-check\.mjs configuration/);
    assert.doesNotMatch(workflow, /continue-on-error:|if:.*(?:failure\(|!cancelled\()/);
    const commands = [...workflow.matchAll(/run: node ([^\n]+)/g)].map(match => match[1]);
    assert.deepEqual(commands, ['.github/scripts/azure-oidc-check.mjs access', '.github/scripts/azure-oidc-check.mjs preflight', '.github/scripts/azure-oidc-check.mjs summary']);
    assert.doesNotMatch(workflow, /az webapp deploy|azure\/webapps-deploy|upload-artifact|download-artifact|npm |--src-path|publish-profile/);
});

test('reused preflight retains the reviewed read-only Azure command inventory', () => {
    const source = readFileSync(new URL('./azure-preflight.mjs', import.meta.url), 'utf8');
    const commands = [...source.matchAll(/\baz\(\[([^\]]*)\]/g)].map(match => {
        const literals = match[1].match(/'[^']*'/g);
        return literals.slice(0, literals.indexOf("'--query'") + 1);
    });
    assert.deepEqual(commands, [
        ["'webapp'", "'show'", "'--query'"],
        ["'webapp'", "'config'", "'show'", "'--query'"],
        ["'webapp'", "'config'", "'appsettings'", "'list'", "'--query'"],
        ["'rest'", "'--method'", "'get'", "'--url'", "'--query'"],
        ["'account'", "'get-access-token'", "'--resource'", "'https://management.azure.com/'", "'--query'"],
    ]);
    assert.doesNotMatch(source, /\bexecSync\b|\bspawn\b|shell:\s*true|stdio:\s*'inherit'/);
});
