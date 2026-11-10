import type { ErrorRequestHandler, RequestHandler } from 'express';
import { InvalidAnalysisInput } from '../domain/skills-gap.js';
import { RecommendationCatalogUnavailable } from '../services/job-course-recommendations.service.js';
import { evaluateJobSkillsGap } from '../services/job-skills-gap.service.js';

export function createJobSkillsGapController(run: (body: unknown) => unknown): RequestHandler {
    return async (req, res) => {
        if (/\?.+/u.test(req.originalUrl)) {
            res.status(400).json({ error: 'INVALID_QUERY', message: 'No se permiten parámetros de consulta.' });
            return;
        }
        try {
            res.status(200).json(await run(req.body));
        } catch (error) {
            if (error instanceof RecommendationCatalogUnavailable) {
                res.status(503).json({ error: 'CATALOG_UNAVAILABLE', message: 'El catálogo no está disponible temporalmente.' });
                return;
            }
            if (!(error instanceof InvalidAnalysisInput)) throw error;
            res.status(400).json({
                error: 'INVALID_EVALUATION_INPUT',
                message: 'Se requiere un CV y entre 1 y 20 ofertas con IDs y habilidades válidos.',
            });
        }
    };
}

export const evaluateJobSkillsGapRequest = createJobSkillsGapController(evaluateJobSkillsGap);

export const handleEvaluationJsonError: ErrorRequestHandler = (error, _req, res, next) => {
    // El manejador de la aplicación responde a JSON malformado y cuerpos demasiado grandes.
    if (error?.status === 415 || (error?.status === 400 && error.type !== 'entity.parse.failed')) {
        res.status(400).json({ error: 'INVALID_JSON_BODY', message: 'Cuerpo JSON inválido o demasiado grande.' });
        return;
    }
    next(error);
};
