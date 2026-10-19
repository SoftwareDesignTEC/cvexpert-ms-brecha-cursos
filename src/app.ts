import express from 'express';
import { createSkillsGapRouter } from './routes/skills-gap.routes.js';

export function createApp(environment = process.env.NODE_ENV) {
    const app = express();
    app.set('query parser', 'extended');
    app.use(express.json());

    app.get('/health', (_req, res) => {
        res.status(200).json({ status: 'ok', service: 'brecha-cursos' });
    });

    const demoEnabled = environment === 'development' || environment === 'test';
    app.use(createSkillsGapRouter(demoEnabled));
    return app;
}
