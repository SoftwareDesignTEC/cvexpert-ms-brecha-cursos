import { analyzeSkillsGap, requireText, type LevelScale, type UserSkill } from '../domain/skills-gap.js';
import type { SkillsGapRepository } from '../repositories/skills-gap.repository.js';

export class AnalysisUnavailable extends Error {
    constructor() { super('El análisis no está disponible temporalmente.'); }
}

// El llamador HTTP resuelve identidad, contexto y escala en el servidor.
export function createSkillsGapAnalysisService(repository: SkillsGapRepository) {
    return {
        async analyze(marketKey: string, scale: LevelScale, userSkills: readonly UserSkill[]) {
            requireText(marketKey);
            let snapshot;
            try { snapshot = await repository.loadMarket(marketKey); }
            catch { throw new AnalysisUnavailable(); }
            return { ...analyzeSkillsGap({ scale, userSkills, ...snapshot }),
                marketStatus: snapshot.requirements.length === 0 ? 'missing' as const : 'available' as const };
        },
    };
}
