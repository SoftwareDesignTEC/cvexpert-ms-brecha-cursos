import assert from 'node:assert/strict';
import { once } from 'node:events';
import type { AddressInfo } from 'node:net';
import { after, before, test } from 'node:test';
import { createApp } from '../src/app.js';
import type { SkillsGapPage } from '../src/services/skills-gap.service.js';

const server = createApp('test').listen(0, '127.0.0.1');
let baseUrl: string;

before(async () => {
    if (!server.listening) await once(server, 'listening');
    baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
after(() => new Promise<void>((resolve, reject) => {
    server.close(error => error ? reject(error) : resolve());
}));

async function getPage(query = ''): Promise<SkillsGapPage> {
    const response = await fetch(`${baseUrl}/skills-gap${query}`);
    assert.equal(response.status, 200);
    assert.match(response.headers.get('content-type') ?? '', /application\/json/);
    assert.equal(response.headers.get('x-data-mode'), 'demo');
    assert.equal(response.headers.get('cache-control'), 'no-store');
    return await response.json() as SkillsGapPage;
}

test('GET /health conserva el contrato existente', async () => {
    const response = await fetch(`${baseUrl}/health`);
    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), { status: 'ok', service: 'brecha-cursos' });
});

test('GET /skills-gap usa valores predeterminados y cumple los esquemas', async () => {
    const body = await getPage();
    assert.deepEqual(Object.keys(body).sort(), ['items', 'page', 'pageSize', 'totalRecords']);
    assert.equal(body.page, 1);
    assert.equal(body.pageSize, 20);
    assert.equal(body.totalRecords, 3);
    assert.equal(body.items.length, body.totalRecords);
    for (const item of body.items) {
        assert.match(item.skillName, /^\[DEMO\]/);
        assert.ok(Number.isInteger(item.userLevel));
        assert.ok(Number.isInteger(item.marketLevel));
        assert.ok(Array.isArray(item.courses));
        assert.ok(item.courses.length > 0);
        for (const course of item.courses) {
            assert.equal(typeof course.id, 'string');
            assert.match(course.title, /^\[DEMO\]/);
            assert.equal(new URL(course.url).hostname, 'example.org');
            assert.equal(typeof course.platform, 'string');
            assert.ok(course.logoUrl === null || typeof course.logoUrl === 'string');
            assert.ok(Number.isInteger(course.durationHours) && course.durationHours >= 0);
        }
    }
});

test('pagina en orden estable, sin duplicados y con última página parcial', async () => {
    const all = await getPage();
    const first = await getPage('?page=1&pageSize=2');
    const second = await getPage('?page=2&pageSize=2');
    assert.equal(first.page, 1);
    assert.equal(second.page, 2);
    assert.equal(first.pageSize, 2);
    assert.equal(second.pageSize, 2);
    assert.equal(first.items.length, 2);
    assert.equal(second.items.length, 1);
    assert.equal(first.totalRecords, all.totalRecords);
    assert.equal(second.totalRecords, all.totalRecords);
    assert.deepEqual([...first.items, ...second.items], all.items);
});

test('permite pageSize 1 y 100 y aplica cada valor predeterminado por separado', async () => {
    const small = await getPage('?pageSize=1');
    assert.equal(small.page, 1);
    assert.equal(small.items.length, 1);
    const large = await getPage('?pageSize=100');
    assert.equal(large.pageSize, 100);
    assert.equal(large.items.length, large.totalRecords);
    const pageOnly = await getPage('?page=2');
    assert.equal(pageOnly.pageSize, 20);
    assert.deepEqual(pageOnly.items, []);
});

test('páginas fuera de rango devuelven items vacío y conservan totalRecords', async () => {
    for (const page of [4, Number.MAX_SAFE_INTEGER]) {
        const body = await getPage(`?page=${page}&pageSize=100`);
        assert.deepEqual(body.items, []);
        assert.equal(body.page, page);
        assert.equal(body.totalRecords, 3);
    }
});

const invalidQueries = [
    'page=0', 'page=-1', 'page=1.5', 'page=abc', 'page=', 'page=1e2',
    'page=%20', 'page=%201', 'page=%2B1', 'page=Infinity', 'page=0x10',
    'page=9007199254740992', 'page=1&page=2', 'page[]=1', 'page[x]=1',
    'pageSize=0', 'pageSize=-1', 'pageSize=1.5', 'pageSize=abc', 'pageSize=',
    'pageSize=101', 'pageSize=1e2', 'pageSize=9007199254740992',
    'pageSize=1&pageSize=2', 'pageSize[]=1', 'pageSize[x]=1',
];
for (const query of invalidQueries) {
    test(`rechaza parámetros inválidos: ${query}`, async () => {
        const response = await fetch(`${baseUrl}/skills-gap?${query}`);
        assert.equal(response.status, 400);
        assert.equal((await response.json() as { error: string }).error, 'INVALID_PAGINATION');
    });
}

for (const environment of ['production', '', 'staging', 'Development']) {
    test(`bloquea datos demo en entorno ${JSON.stringify(environment)} y mantiene health`, async () => {
        const guardedServer = createApp(environment).listen(0, '127.0.0.1');
        try {
            if (!guardedServer.listening) await once(guardedServer, 'listening');
            const url = `http://127.0.0.1:${(guardedServer.address() as AddressInfo).port}`;
            const response = await fetch(`${url}/skills-gap`);
            assert.equal(response.status, 503);
            const body = await response.json() as { error: string; items?: unknown };
            assert.equal(body.error, 'SKILLS_GAP_UNAVAILABLE');
            assert.equal(body.items, undefined);
            assert.equal((await fetch(`${url}/health`)).status, 200);
        } finally {
            await new Promise<void>((resolve, reject) => {
                guardedServer.close(error => error ? reject(error) : resolve());
            });
        }
    });
}

test('development habilita explícitamente la demostración', async () => {
    const demoServer = createApp('development').listen(0, '127.0.0.1');
    try {
        if (!demoServer.listening) await once(demoServer, 'listening');
        const url = `http://127.0.0.1:${(demoServer.address() as AddressInfo).port}`;
        const response = await fetch(`${url}/skills-gap`);
        assert.equal(response.status, 200);
        assert.equal(response.headers.get('x-data-mode'), 'demo');
    } finally {
        await new Promise<void>((resolve, reject) => {
            demoServer.close(error => error ? reject(error) : resolve());
        });
    }
});

test('sin NODE_ENV la aplicación bloquea la demostración por defecto', async () => {
    const previousEnvironment = process.env.NODE_ENV;
    delete process.env.NODE_ENV;
    const guardedServer = createApp().listen(0, '127.0.0.1');
    try {
        if (!guardedServer.listening) await once(guardedServer, 'listening');
        const url = `http://127.0.0.1:${(guardedServer.address() as AddressInfo).port}`;
        const response = await fetch(`${url}/skills-gap`);
        assert.equal(response.status, 503);
        assert.equal((await response.json() as { error: string }).error, 'SKILLS_GAP_UNAVAILABLE');
    } finally {
        if (previousEnvironment === undefined) delete process.env.NODE_ENV;
        else process.env.NODE_ENV = previousEnvironment;
        await new Promise<void>((resolve, reject) => {
            guardedServer.close(error => error ? reject(error) : resolve());
        });
    }
});
