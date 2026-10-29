import { Router } from 'express';
import { createSkillsGapController } from '../controllers/skills-gap.controller.js';

export function createSkillsGapRouter(demoEnabled: boolean) {
    const router = Router();
    router.get('/skills-gap', createSkillsGapController(demoEnabled));
    return router;
}
