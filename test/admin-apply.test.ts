import assert from 'node:assert/strict';
import { generateKeyPairSync, sign } from 'node:crypto';
import { test } from 'node:test';
import { readFile } from 'node:fs/promises';
import { applicationConfig, administrativeConfig } from '../scripts/admin-import/config.js';
import { argumentsFor } from '../scripts/admin-apply.js';
import { bytesHash, canonical, digest, validateApproval, type Approval } from '../scripts/admin-import/approval.js';
import { prepareInput } from '../scripts/admin-import/planner.js';

const target = { server:'test.postgres.database.azure.com',port:5432,database:'TEST',identity:'TEST_writer' };
const env = { ADMIN_IMPORT_SERVER:target.server,ADMIN_IMPORT_PORT:'5432',ADMIN_IMPORT_DATABASE:target.database,
    ADMIN_IMPORT_IDENTITY:target.identity,ADMIN_IMPORT_PASSWORD:'TEST-only' };
test('apply: identidad separada, TLS fijo, CI/App Service rechazados sin socket', () => {
    assert.match(applicationConfig(target,env).options!,/default_transaction_read_only=off/);
    assert.deepEqual(applicationConfig(target,env).ssl,{rejectUnauthorized:true,servername:target.server});
    for(const patch of [{CI:'true'},{TF_BUILD:'true'},{GITLAB_CI:'true'},{GITHUB_ACTIONS:'true'},
        {WEBSITE_INSTANCE_ID:'TEST'},{NODE_TLS_REJECT_UNAUTHORIZED:'0'}]) {
        assert.throws(()=>applicationConfig(target,{...env,...patch}));
        assert.throws(()=>administrativeConfig(target,{...env,...patch}));
    }
    assert.throws(()=>applicationConfig({...target,identity:'cvexpert_pgadmin'},{...env,ADMIN_IMPORT_IDENTITY:'cvexpert_pgadmin'}));
    for(const args of [[],['apply','--force'],['apply','--approval','x','--approval','y'],['sign','--proposal','x','--private-key','k','--output','x']]) {
        assert.throws(()=>argumentsFor(args));
    }
});
test('aprobación firmada: expiración, decisiones explícitas, hash exacto y clave confiable', async () => {
    const read = async(name:string)=>JSON.parse(await readFile(new URL(`./fixtures/${name}`,import.meta.url),'utf8'));
    const input=prepareInput(await read('catalog-import.test.json'),await read('market-import.test.json'),await read('market-import.test-scale.json'));
    assert.throws(() => prepareInput(input.catalog, input.market, {key:'cv-skill-v1',levels:[4,3,2,1]}));
    assert.throws(() => prepareInput({...input.catalog,skills:['[DEMO] skill']}, input.market, input.scale));
    const bundle={input,files:{catalog:digest('TEST catalog'),market:digest('TEST market'),scale:digest('TEST scale'),evidence:digest('TEST evidence')}};
    const keys=generateKeyPairSync('ed25519'),pem=keys.publicKey.export({type:'spki',format:'pem'}).toString();
    const fingerprint=bytesHash(keys.publicKey.export({type:'spki',format:'der'}));
    const payload:any={formatVersion:1,executionId:'12345678-1234-1234-1234-123456789abc',target,readerIdentity:'TEST_reader',
        files:bundle.files,inputSha256:digest(input),plan:{},planSha256:digest({}),reviewer:'TEST',ticket:'TEST',
        approvedAt:new Date(Date.now()-1000).toISOString(),expiresAt:new Date(Date.now()+60000).toISOString(),
        review:{sources:true,editorialLevels:true,freshness:true,authorizeWrites:true,marketUpdates:false}};
    const signed=(p:any):Approval=>({payload:p,signature:sign(null,Buffer.from(canonical(p)),keys.privateKey).toString('base64')});
    assert.equal(validateApproval(signed(payload),pem,fingerprint,bundle).executionId,payload.executionId);
    for(const patch of [{readerIdentity:target.identity},{expiresAt:'2000-01-01T00:00:00.000Z'},
        {review:{...payload.review,sources:false}},{files:{...bundle.files,evidence:digest('TEST changed')}},
        {planSha256:digest('TEST changed')},{ticket:''}]) {
        assert.throws(()=>validateApproval(signed({...payload,...patch}),pem,fingerprint,bundle));
    }
    const tampered=signed(payload); tampered.payload={...payload,target:{...target,database:'TEST changed'}};
    assert.throws(()=>validateApproval(tampered,pem,fingerprint,bundle));
});
