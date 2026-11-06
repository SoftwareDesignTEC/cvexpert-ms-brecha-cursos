import express, { type ErrorRequestHandler } from 'express';
import { createApimCertificateGuard } from './security/apim-certificate.js';
import { createDocumentationRouter } from './documentation.js';
import { createSkillsGapRouter } from './routes/skills-gap.routes.js';
import { createCoursesRouter } from './routes/courses.routes.js';
import { createCoursesService } from './services/courses.service.js';
import { createPostgresCoursesRepository, type CoursesRepository } from './repositories/courses.repository.js';
import { createPostgresSkillsGapRepository, createPostgresUserSkillsRepository, type SkillsGapRepository, type UserSkillsRepository } from './repositories/skills-gap.repository.js';

export function createApp(environment = process.env.NODE_ENV, repository: CoursesRepository = createPostgresCoursesRepository(), securitySettings: NodeJS.ProcessEnv = process.env,
    users: UserSkillsRepository = createPostgresUserSkillsRepository(), market: SkillsGapRepository = createPostgresSkillsGapRepository()) {
    const app = express();
    app.set('query parser', 'extended');

    app.get('/health', (_req, res) => {
        res.status(200).json({ status: 'ok', service: 'brecha-cursos' });
    });

    app.use(createApimCertificateGuard(environment, securitySettings));
    app.use(createDocumentationRouter());

    app.use(createSkillsGapRouter(users, market, securitySettings.SKILLS_GAP_MARKET_KEY));
    app.use(createCoursesRouter(createCoursesService(repository)));
    const jsonErrors: ErrorRequestHandler = (error, _req, res, next) => {
        if (error?.type === 'entity.parse.failed' || error?.type === 'entity.too.large') {
            res.status(error.type === 'entity.too.large' ? 413 : 400).json({
                error: 'INVALID_JSON_BODY', message: 'Cuerpo JSON inválido o demasiado grande.',
            });
            return;
        }
        next(error);
    };
    app.use(jsonErrors);
    return Object.assign(app, {
        async closeResources() { await Promise.all([repository.close?.(), users.close(), market.close()]); },
    });
}
