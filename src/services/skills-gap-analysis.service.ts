import { analyzeSkillsGap, requireText, type LevelScale, type UserSkill } from '../domain/skills-gap.js';
import type { SkillsGapRepository } from '../repositories/skills-gap.repository.js';

export class AnalysisUnavailable extends Error {
    constructor() { super('El análisis no está disponible temporalmente.'); }
}

// Uso interno exclusivamente: todavía no existe una frontera HTTP autenticada
// ni un contrato aprobado para obtener las habilidades y su escala.
export function createSkillsGapAnalysisService(repository: SkillsGapRepository) {
    return {
        async analyze(marketKey: string, scale: LevelScale, userSkills: readonly UserSkill[]) {
            requireText(marketKey);
            let snapshot;
            try { snapshot = await repository.loadMarket(marketKey); }
            catch { throw new AnalysisUnavailable(); }
            return analyzeSkillsGap({ scale, userSkills, ...snapshot });
        },
    };
}
