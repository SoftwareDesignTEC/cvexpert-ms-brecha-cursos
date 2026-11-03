import { execFileSync } from 'node:child_process';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

// Configuration guards only: not proof of APIM connectivity, mTLS or application health.
export function validateDeployment({ site, config, settings, scmBasicAuth, ftpBasicAuth, deploymentObjectId, networkModel } = {}) {
    const require = (condition, message) => { if (!condition) throw new Error(message); };
    const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
    const principal = value => typeof value === 'string' && /^[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}$/i.test(value);
    require(object(site) && object(config) && object(settings), 'Incomplete Azure configuration.');
    // GitHub Actions supplies an empty string for an unset variable. Never infer from Azure state.
    require(networkModel === undefined || networkModel === '' || networkModel === 'public-mtls',
        'Unknown AZURE_BACKEND_NETWORK_MODEL.');
    require(site.name === 'cvexpert-ms-brecha-cursos' && typeof site.resourceGroup === 'string' && site.resourceGroup.toLowerCase() === 'rg-cvexpert',
        'Wrong App Service target.');
    require(typeof site.kind === 'string' && site.kind.split(',').includes('linux'), 'A Linux App Service is required for this package.');
    if (networkModel === 'public-mtls') {
        require(site.publicNetworkAccess === 'Enabled', 'public-mtls requires explicit public network access.');
        require(site.clientCertEnabled === true && site.clientCertMode === 'Required',
            'public-mtls requires client certificates enabled in Required mode.');
        require(site.clientCertExclusionPaths === undefined || site.clientCertExclusionPaths === null
            || site.clientCertExclusionPaths === '', 'Client certificate path exclusions are not approved.');
        // Same normalization and all-or-nothing format policy as the application middleware.
        require(typeof settings.APIM_CERT_THUMBPRINTS === 'string'
            && settings.APIM_CERT_THUMBPRINTS.split(',').every(value => /^[A-F0-9]{40}$/.test(value.trim().toUpperCase())),
            'Configure a complete, valid APIM_CERT_THUMBPRINTS list.');
    } else {
        require(site.publicNetworkAccess === 'Disabled', 'Backend must remain private unless public-mtls is explicitly selected.');
    }
    require(site.httpsOnly === true, 'HTTPS-only is required.');
    require(['1.2', '1.3'].includes(config.minTlsVersion) && ['1.2', '1.3'].includes(config.scmMinTlsVersion),
        'Both application and SCM endpoints require TLS >= 1.2.');
    require(config.linuxFxVersion === 'NODE|24-lts', 'Configure the Azure Node.js 24 runtime before deployment.');
    require(typeof config.appCommandLine === 'string' && ['npm start', 'node dist/server.js'].includes(config.appCommandLine.trim()),
        'Configure an explicit startup command: npm start or node dist/server.js.');
    require(settings.NODE_ENV === 'production', 'Azure NODE_ENV must be production.');
    require(settings.APIM_ALLOW_INSECURE_LOCAL === undefined || settings.APIM_ALLOW_INSECURE_LOCAL === 'false',
        'Disable APIM_ALLOW_INSECURE_LOCAL in Azure.');
    require(settings.SCM_DO_BUILD_DURING_DEPLOYMENT === 'false' && settings.ENABLE_ORYX_BUILD === 'false',
        'Disable remote build; deploy only the tested package.');
    require(scmBasicAuth === false && ftpBasicAuth === false, 'SCM and FTP basic authentication must be disabled.');
    require(object(site.identity), 'Configure the separate runtime managed identity first.');
    const assigned = site.identity.userAssignedIdentities;
    require(assigned == null || object(assigned), 'Invalid runtime managed identities.');
    const runtimeIds = [];
    if (site.identity.principalId != null) {
        require(principal(site.identity.principalId), 'Invalid runtime managed identity principal.');
        runtimeIds.push(site.identity.principalId.toLowerCase());
    }
    for (const identity of Object.values(assigned ?? {})) {
        require(object(identity) && principal(identity.principalId), 'Invalid runtime managed identity principal.');
        runtimeIds.push(identity.principalId.toLowerCase());
    }
    require(runtimeIds.length > 0, 'Configure the separate runtime managed identity first.');
    require(principal(deploymentObjectId),
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
    const site = az(['webapp', 'show', ...target, '--query',
        '{id:id,name:name,resourceGroup:resourceGroup,kind:kind,publicNetworkAccess:publicNetworkAccess,httpsOnly:httpsOnly,clientCertEnabled:clientCertEnabled,clientCertMode:clientCertMode,clientCertExclusionPaths:clientCertExclusionPaths,identity:identity}']);
    const config = az(['webapp', 'config', 'show', ...target, '--query',
        '{minTlsVersion:minTlsVersion,scmMinTlsVersion:scmMinTlsVersion,linuxFxVersion:linuxFxVersion,appCommandLine:appCommandLine}']);
    const selectedSettings = az(['webapp', 'config', 'appsettings', 'list', ...target, '--query',
        "[?name=='NODE_ENV' || name=='SCM_DO_BUILD_DURING_DEPLOYMENT' || name=='ENABLE_ORYX_BUILD' || name=='APIM_CERT_THUMBPRINTS' || name=='APIM_ALLOW_INSECURE_LOCAL'].{name:name,value:value}"]);
    if (!Array.isArray(selectedSettings) || selectedSettings.some(item => !item || typeof item.name !== 'string' || typeof item.value !== 'string')
        || new Set(selectedSettings.map(item => item.name)).size !== selectedSettings.length
        || typeof site?.id !== 'string') throw new Error('Incomplete Azure query results.');
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
    validateDeployment({ site, config, settings, scmBasicAuth: policy('scm'), ftpBasicAuth: policy('ftp'), deploymentObjectId: oid,
        networkModel: process.env.AZURE_BACKEND_NETWORK_MODEL });
    console.log('Azure configuration guards passed; APIM connectivity, certificate validation and live functionality remain unverified.');
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
    try { main(); } catch (error) {
        console.error(error.message);
        process.exitCode = 1;
    }
}
