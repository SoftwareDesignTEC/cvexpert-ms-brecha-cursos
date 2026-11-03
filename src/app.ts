import express from 'express';
import { createApimCertificateGuard } from './security/apim-certificate.js';
import { createDocumentationRouter } from './documentation.js';
import { createSkillsGapRouter } from './routes/skills-gap.routes.js';
import { createCoursesRouter } from './routes/courses.routes.js';
import { createCoursesService } from './services/courses.service.js';
import { createPostgresCoursesRepository, type CoursesRepository } from './repositories/courses.repository.js';

export function createApp(environment = process.env.NODE_ENV, repository: CoursesRepository = createPostgresCoursesRepository(), securitySettings: NodeJS.ProcessEnv = process.env) {
    const app = express();
    app.set('query parser', 'extended');

    app.get('/health', (_req, res) => {
        res.status(200).json({ status: 'ok', service: 'brecha-cursos' });
    });

    app.use(createApimCertificateGuard(environment, securitySettings));
    app.use(express.json());
    app.use(createDocumentationRouter());

    const demoEnabled = environment === 'development' || environment === 'test';
    app.use(createSkillsGapRouter(demoEnabled));
    app.use(createCoursesRouter(createCoursesService(repository)));
    return Object.assign(app, {
        async closeResources() { await repository.close?.(); },
    });
}
