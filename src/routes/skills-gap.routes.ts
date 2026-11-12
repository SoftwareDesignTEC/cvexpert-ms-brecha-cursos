import { Router, json, type RequestHandler } from 'express';
import { evaluateJobSkillsGapRequest, handleEvaluationJsonError } from '../controllers/job-skills-gap.controller.js';
import { createSkillsGapController, createSkillsGapInputController, requireSkillsGapIdentity } from '../controllers/skills-gap.controller.js';
import type { UserSkillsRepository, SkillsGapRepository } from '../repositories/skills-gap.repository.js';
import { createSkillsGapAnalysisService } from '../services/skills-gap-analysis.service.js';

export function createSkillsGapRouter(users: UserSkillsRepository, market: SkillsGapRepository, marketKey: string | undefined,
    recommendations?: RequestHandler) {
    const router = Router();
    router.use('/skills-gap', requireSkillsGapIdentity);
    router.put('/skills-gap/input', json({ limit: '100kb' }), createSkillsGapInputController(users));
    router.post('/skills-gap/evaluate', json({ limit: '100kb' }), handleEvaluationJsonError, evaluateJobSkillsGapRequest);
    if (recommendations) {
        router.post('/skills-gap/recommendations', json({ limit: '100kb' }), handleEvaluationJsonError, recommendations);
    }
    router.get('/skills-gap', createSkillsGapController(users, createSkillsGapAnalysisService(market), marketKey));
    return router;
}
