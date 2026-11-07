import { Router, json } from 'express';
import { createSkillsGapController, createSkillsGapInputController, requireSkillsGapIdentity } from '../controllers/skills-gap.controller.js';
import type { UserSkillsRepository, SkillsGapRepository } from '../repositories/skills-gap.repository.js';
import { createSkillsGapAnalysisService } from '../services/skills-gap-analysis.service.js';

export function createSkillsGapRouter(users: UserSkillsRepository, market: SkillsGapRepository, marketKey: string | undefined) {
    const router = Router();
    router.use('/skills-gap', requireSkillsGapIdentity);
    router.put('/skills-gap/input', json({ limit: '100kb' }), createSkillsGapInputController(users));
    router.get('/skills-gap', createSkillsGapController(users, createSkillsGapAnalysisService(market), marketKey));
    return router;
}
