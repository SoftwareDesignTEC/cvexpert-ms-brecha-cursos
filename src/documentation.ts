import express from 'express';
import { readFileSync } from 'node:fs';
import swaggerUi from 'swagger-ui-dist';
import { parse } from 'yaml';

export function createDocumentationRouter() {
    const router = express.Router();
    const contract = readFileSync(new URL('../openapi.yaml', import.meta.url), 'utf8');
    const specification: unknown = parse(contract);
    router.get('/openapi.yaml', (_req, res) => { res.type('application/yaml').send(contract); });
    router.get('/openapi.json', (_req, res) => { res.json(specification); });
    router.get('/docs', (req, res, next) => {
        if (!req.path.endsWith('/')) { res.redirect(308, 'docs/'); return; }
        next();
    });
    router.get('/docs/', (_req, res) => {
        res.type('html').send(`<!doctype html><html lang="es"><head><meta charset="utf-8"><title>CVExpert API</title>
<link rel="stylesheet" href="./swagger-ui.css"></head><body><div id="swagger-ui"></div>
<script src="./swagger-ui-bundle.js"></script><script src="./init.js"></script></body></html>`);
    });
    router.get('/docs/init.js', (_req, res) => {
        res.type('js').send(`SwaggerUIBundle({url: '../openapi.json', dom_id: '#swagger-ui', validatorUrl: null});`);
    });
    router.use('/docs', express.static(swaggerUi.getAbsoluteFSPath(), { index: false, redirect: false }));
    return router;
}
