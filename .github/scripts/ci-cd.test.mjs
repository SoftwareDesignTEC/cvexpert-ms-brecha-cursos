import assert from 'node:assert/strict';
import { test } from 'node:test';
import { classifyChanges, requiresCi } from './ci-paths.mjs';
import { validateDeployment } from './azure-preflight.mjs';

test('path filter skips only known documentation and runs for unknown, mixed or empty changes', () => {
    assert.equal(requiresCi(['README.md', 'docs/architecture.md']), false);
    for (const files of [[], ['src/server.ts'], ['db/migrations/002_new.sql'], ['package-lock.json'],
        ['.github/workflows/ci-cd.yml'], ['.github/scripts/ci-paths.mjs'], ['docs/script.sh'], ['docs/ci.yml'],
        ['README.md', 'src/deleted.ts'], ['new-root-file'], ['openapi.yaml'], ['.npmrc'], ['Dockerfile']]) {
        assert.equal(requiresCi(files), true, JSON.stringify(files));
    }
});

test('pushes always run CI and missing/untrusted PR revisions cannot skip checks', () => {
    assert.equal(classifyChanges('push', '', ''), true);
    assert.throws(() => classifyChanges('pull_request', '', ''), /invalid PR revisions/);
    assert.throws(() => classifyChanges('pull_request', '--help', 'a'.repeat(40)), /invalid PR revisions/);
});

const safeDeployment = () => ({
    site: {
        name: 'cvexpert-ms-brecha-cursos', resourceGroup: 'rg-cvexpert', kind: 'app,linux',
        publicNetworkAccess: 'Disabled', httpsOnly: true,
        identity: { principalId: '11111111-1111-1111-1111-111111111111' },
    },
    config: { minTlsVersion: '1.2', scmMinTlsVersion: '1.2', linuxFxVersion: 'NODE|24-lts', appCommandLine: 'npm start' },
    settings: { NODE_ENV: 'production', SCM_DO_BUILD_DURING_DEPLOYMENT: 'false', ENABLE_ORYX_BUILD: 'false' },
    scmBasicAuth: false, ftpBasicAuth: false,
    deploymentObjectId: '22222222-2222-2222-2222-222222222222',
});

test('private production target with distinct identities passes read-only deployment checks', () => {
    assert.doesNotThrow(() => validateDeployment(safeDeployment()));
});

test('public, unknown or certificate-only protection cannot bypass private network requirement', () => {
    for (const access of ['Enabled', null, undefined]) {
        const state = safeDeployment();
        Object.assign(state.site, { publicNetworkAccess: access, clientCertEnabled: true, clientCertMode: 'Required' });
        assert.throws(() => validateDeployment(state), /must remain private/);
    }
});

test('OIDC deploy principal cannot be the system or user-assigned runtime identity', () => {
    const system = safeDeployment();
    system.deploymentObjectId = system.site.identity.principalId;
    assert.throws(() => validateDeployment(system), /must differ/);
    const user = safeDeployment();
    user.site.identity.userAssignedIdentities = { '/runtime-identity': { principalId: user.deploymentObjectId } };
    assert.throws(() => validateDeployment(user), /must differ/);
    const absent = safeDeployment();
    absent.site.identity = undefined;
    assert.throws(() => validateDeployment(absent), /separate runtime managed identity/);
});

test('deployment rejects wrong target, insecure TLS, wrong runtime and missing explicit startup', () => {
    for (const [section, key, value] of [
        ['site', 'name', 'other-app'], ['site', 'resourceGroup', 'other-rg'], ['site', 'kind', 'app'],
        ['site', 'httpsOnly', false], ['config', 'minTlsVersion', '1.0'], ['config', 'scmMinTlsVersion', '1.0'],
        ['config', 'linuxFxVersion', 'NODE|22-lts'], ['config', 'appCommandLine', ''],
    ]) {
        const state = safeDeployment();
        state[section][key] = value;
        assert.throws(() => validateDeployment(state), undefined, `${section}.${key}`);
    }
});

test('deployment rejects demo mode, remote builds and basic publishing credentials', () => {
    for (const key of ['NODE_ENV', 'SCM_DO_BUILD_DURING_DEPLOYMENT', 'ENABLE_ORYX_BUILD']) {
        const state = safeDeployment();
        state.settings[key] = key === 'NODE_ENV' ? 'development' : 'true';
        assert.throws(() => validateDeployment(state));
    }
    for (const key of ['scmBasicAuth', 'ftpBasicAuth']) {
        const state = safeDeployment();
        state[key] = true;
        assert.throws(() => validateDeployment(state), /basic authentication/);
    }
});
