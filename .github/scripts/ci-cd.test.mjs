import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readFileSync } from 'node:fs';
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

const publicDeployment = () => {
    const state = safeDeployment();
    state.networkModel = 'public-mtls';
    Object.assign(state.site, { publicNetworkAccess: 'Enabled', clientCertEnabled: true, clientCertMode: 'Required' });
    state.settings.APIM_CERT_THUMBPRINTS = 'FDF119D5BE797DD62E6CC87002C183CC6E70274B';
    return state;
};

test('explicit public-mtls accepts only the public certificate-protected model', () => {
    assert.doesNotThrow(() => validateDeployment(publicDeployment()));
    for (const exclusion of [undefined, null, '']) {
        const state = publicDeployment();
        state.site.clientCertExclusionPaths = exclusion;
        state.settings.APIM_CERT_THUMBPRINTS = ` ${'ab'.repeat(20)} , ${'CD'.repeat(20)} `;
        state.settings.APIM_ALLOW_INSECURE_LOCAL = 'false';
        state.config.minTlsVersion = state.config.scmMinTlsVersion = '1.3';
        state.config.appCommandLine = ' node dist/server.js ';
        state.site.identity = { userAssignedIdentities: { '/runtime': { principalId: safeDeployment().site.identity.principalId } } };
        assert.doesNotThrow(() => validateDeployment(state));
    }
    for (const networkModel of [undefined, '', null, 'private', 'PUBLIC-MTLS', ' public-mtls', true, {}]) {
        const state = publicDeployment();
        state.networkModel = networkModel;
        assert.throws(() => validateDeployment(state));
    }
    for (const networkModel of [undefined, '']) {
        assert.doesNotThrow(() => validateDeployment({ ...safeDeployment(), networkModel }));
    }
    for (const networkModel of [null, 'private', false, 1]) {
        assert.throws(() => validateDeployment({ ...safeDeployment(), networkModel }), /Unknown/);
    }
    const state = publicDeployment();
    state.site.publicNetworkAccess = 'Disabled';
    assert.throws(() => validateDeployment(state), /explicit public/);
});

// Exercise the actual validator in both models; missing/null/wrong types must fail closed.
const commonFields = [
    ['site', 'name', ['other']], ['site', 'resourceGroup', ['other', 12]], ['site', 'kind', ['app', 'notlinux', ['linux']]],
    ['site', 'httpsOnly', [false, 'true']],
    ['config', 'minTlsVersion', ['1.0', '1.1', 1.2]], ['config', 'scmMinTlsVersion', ['1.0', '1.1', 1.2]],
    ['config', 'linuxFxVersion', ['NODE|22-lts', '']], ['config', 'appCommandLine', ['', 'npm run dev', 'npm start; echo unsafe', []]],
    ['settings', 'NODE_ENV', ['development', 'test', '']],
    ['settings', 'SCM_DO_BUILD_DURING_DEPLOYMENT', ['true', false]], ['settings', 'ENABLE_ORYX_BUILD', ['true', false]],
    ['site', 'identity', [{}, [], { principalId: 12 }, { principalId: 'invalid' },
        { userAssignedIdentities: [] }, { userAssignedIdentities: { '/runtime': null } },
        { userAssignedIdentities: { '/runtime': {} } }]],
];
for (const [model, factory] of [['private', safeDeployment], ['public-mtls', publicDeployment]]) {
    for (const [section, key, invalid] of commonFields) {
        test(`${model}: rejects incomplete or unsafe ${section}.${key}`, () => {
            for (const value of [undefined, null, ...invalid]) {
                const state = factory();
                if (value === undefined) delete state[section][key];
                else state[section][key] = value;
                assert.throws(() => validateDeployment(state), Error, `${section}.${key}: ${JSON.stringify(value)}`);
            }
        });
    }
    test(`${model}: rejects incomplete top-level data, publishing credentials, bypass and shared identities`, () => {
        for (const key of ['site', 'config', 'settings', 'scmBasicAuth', 'ftpBasicAuth', 'deploymentObjectId']) {
            for (const value of [undefined, null, true, 'false', [], {}]) {
                const state = factory();
                state[key] = value;
                assert.throws(() => validateDeployment(state));
            }
        }
        for (const value of ['true', true, null, '', 'TRUE', 1]) {
            const state = factory();
            state.settings.APIM_ALLOW_INSECURE_LOCAL = value;
            assert.throws(() => validateDeployment(state), /APIM_ALLOW_INSECURE_LOCAL/);
        }
        for (const userAssigned of [false, true]) {
            const state = factory();
            if (userAssigned) state.site.identity.userAssignedIdentities = { '/runtime': { principalId: state.deploymentObjectId.toUpperCase() } };
            else state.site.identity.principalId = state.deploymentObjectId.toUpperCase();
            assert.throws(() => validateDeployment(state), /must differ/);
        }
    });
}

for (const [section, key, invalid] of [
    ['site', 'publicNetworkAccess', ['Disabled', true, 'enabled']],
    ['site', 'clientCertEnabled', [false, 'true', 1]],
    ['site', 'clientCertMode', ['Optional', 'OptionalInteractiveUser', 'required', true]],
    ['settings', 'APIM_CERT_THUMBPRINTS', ['', ' ', 'A'.repeat(39), 'A'.repeat(41), 'G'.repeat(40),
        'AA:'.repeat(19) + 'AA', 'A'.repeat(40) + ',', ',' + 'A'.repeat(40), 'A'.repeat(40) + ',invalid', [], 12]],
]) {
    test(`public-mtls: rejects missing or invalid ${key}`, () => {
        for (const value of [undefined, null, ...invalid]) {
            const state = publicDeployment();
            state[section][key] = value;
            assert.throws(() => validateDeployment(state));
        }
    });
}

test('public-mtls rejects every nonempty exclusion and unexpected exclusion type', () => {
    for (const value of ['/health', '/health;/courses', '/', ' ', false, 0, [], {}]) {
        const state = publicDeployment();
        state.site.clientCertExclusionPaths = value;
        assert.throws(() => validateDeployment(state), /exclusions/);
    }
});

test('workflow passes the explicit Actions network variable and retains the CD opt-in', () => {
    // The changes job runs these tests before npm ci: keep the guards dependency-free.
    // actionlint checks the YAML structure separately.
    const workflow = readFileSync(new URL('../workflows/ci-cd.yml', import.meta.url), 'utf8');
    const deploy = workflow.slice(workflow.indexOf('\n  deploy:'));
    assert.match(deploy, /\n      AZURE_BACKEND_NETWORK_MODEL: \$\{\{ vars\.AZURE_BACKEND_NETWORK_MODEL \}\}\r?\n/);
    assert.match(deploy, /vars\.ENABLE_AZURE_DEPLOY == 'true'/);
    assert.match(deploy, /\n    environment: azure-production\r?\n/);
    const preflight = deploy.indexOf('run: node .github/scripts/azure-preflight.mjs');
    const deployment = deploy.indexOf('az webapp deploy');
    assert.ok(preflight >= 0 && deployment > preflight);
    assert.doesNotMatch(workflow, /\n\s*ENABLE_AZURE_DEPLOY:/);
});
