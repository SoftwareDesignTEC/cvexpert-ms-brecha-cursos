import { execFileSync } from 'node:child_process';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

// Configuration guards only: not proof of APIM connectivity, mTLS or application health.
export function validateDeployment({ site, config, settings, scmBasicAuth, ftpBasicAuth, deploymentObjectId }) {
    const require = (condition, message) => { if (!condition) throw new Error(message); };
    require(site.name === 'cvexpert-ms-brecha-cursos' && site.resourceGroup?.toLowerCase() === 'rg-cvexpert',
        'Wrong App Service target.');
    require(site.kind?.includes('linux'), 'A Linux App Service is required for this package.');
    require(site.publicNetworkAccess === 'Disabled', 'Backend must remain private; public deployment is not approved.');
    require(site.httpsOnly === true, 'HTTPS-only is required.');
    require(['1.2', '1.3'].includes(config.minTlsVersion) && ['1.2', '1.3'].includes(config.scmMinTlsVersion),
        'Both application and SCM endpoints require TLS >= 1.2.');
    require(config.linuxFxVersion === 'NODE|24-lts', 'Configure the Azure Node.js 24 runtime before deployment.');
    require(['npm start', 'node dist/server.js'].includes(config.appCommandLine?.trim()),
        'Configure an explicit startup command: npm start or node dist/server.js.');
    require(settings.NODE_ENV === 'production', 'Azure NODE_ENV must be production.');
    require(settings.SCM_DO_BUILD_DURING_DEPLOYMENT === 'false' && settings.ENABLE_ORYX_BUILD === 'false',
        'Disable remote build; deploy only the tested package.');
    require(scmBasicAuth === false && ftpBasicAuth === false, 'SCM and FTP basic authentication must be disabled.');
    const runtimeIds = [site.identity?.principalId,
        ...Object.values(site.identity?.userAssignedIdentities ?? {}).map(identity => identity.principalId)]
        .filter(Boolean).map(id => id.toLowerCase());
    require(runtimeIds.length > 0, 'Configure the separate runtime managed identity first.');
    require(typeof deploymentObjectId === 'string' && /^[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}$/i.test(deploymentObjectId),
        'Unable to identify the OIDC deployment principal.');
    require(!runtimeIds.includes(deploymentObjectId.toLowerCase()),
        'OIDC deploy identity must differ from runtime / Key Vault managed identities.');
}

function az(args) {
    try {
        return JSON.parse(execFileSync('az', [...args, '--only-show-errors', '--output', 'json'],
            { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }));
    } catch {
        // CLI errors/objects can contain tokens or configuration values. Never dump them.
        throw new Error('A required read-only Azure query failed. Check target, login and scoped permissions.');
    }
}

function main() {
    const target = ['--resource-group', 'rg-cvexpert', '--name', 'cvexpert-ms-brecha-cursos'];
    const site = az(['webapp', 'show', ...target]);
    const config = az(['webapp', 'config', 'show', ...target]);
    const selectedSettings = az(['webapp', 'config', 'appsettings', 'list', ...target, '--query',
        "[?name=='NODE_ENV' || name=='SCM_DO_BUILD_DURING_DEPLOYMENT' || name=='ENABLE_ORYX_BUILD']"]);
    const settings = Object.fromEntries(selectedSettings.map(item => [item.name, item.value]));
    const policy = name => az(['rest', '--method', 'get', '--url',
        `https://management.azure.com${site.id}/basicPublishingCredentialsPolicies/${name}?api-version=2022-03-01`,
        '--query', 'properties.allow']);
    // Decode only the principal oid from the token obtained by the authenticated CLI.
    // The token never goes to stdout, files, workflow outputs or command arguments.
    const token = az(['account', 'get-access-token', '--resource', 'https://management.azure.com/', '--query', 'accessToken']);
    let oid;
    try {
        ({ oid } = JSON.parse(Buffer.from(token.split('.')[1], 'base64url').toString('utf8')));
    } catch {
        throw new Error('Unable to inspect the authenticated deployment principal.');
    }
    validateDeployment({ site, config, settings, scmBasicAuth: policy('scm'), ftpBasicAuth: policy('ftp'), deploymentObjectId: oid });
    console.log('Azure configuration guards passed; APIM connectivity, certificate validation and live functionality remain unverified.');
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
    try { main(); } catch (error) {
        console.error(error.message);
        process.exitCode = 1;
    }
}
