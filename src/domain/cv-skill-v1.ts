import { InvalidAnalysisInput, requireText, type UserSkill } from './skills-gap.js';

export const cvSkillScale = { key: 'cv-skill-v1', levels: [1, 2, 3, 4] } as const;
const levels = { beginner: 1, intermediate: 2, advanced: 3, expert: 4 } as const;
export type CvSkillLevel = keyof typeof levels;

export function cvSkillOrdinal(level: CvSkillLevel): number { return levels[level]; }

export function isCvSkillLevel(value: unknown): value is CvSkillLevel {
    return typeof value === 'string' && Object.hasOwn(levels, value);
}

// Entrada estricta: null expresa desconocimiento; un texto desconocido es un error,
// nunca una evaluación cero ni una conversión porcentual.
export function adaptCvSkillInput(body: unknown): UserSkill[] {
    if (!body || typeof body !== 'object' || Array.isArray(body)
        || Object.keys(body).length !== 1 || !('skills' in body) || !Array.isArray(body.skills)
        || body.skills.length > 500) throw new InvalidAnalysisInput();
    const seen = new Set<string>();
    return body.skills.map((item: unknown) => {
        if (!item || typeof item !== 'object' || Array.isArray(item)
            || Object.keys(item).length !== 2 || !('skillName' in item) || !('level' in item)
            || typeof item.skillName !== 'string') throw new InvalidAnalysisInput();
        requireText(item.skillName);
        if (item.skillName.length > 200 || seen.has(item.skillName)) throw new InvalidAnalysisInput();
        seen.add(item.skillName);
        const level = item.level === null ? null : isCvSkillLevel(item.level) ? levels[item.level] : undefined;
        if (level === undefined) throw new InvalidAnalysisInput();
        return { skillName: item.skillName, level, scaleKey: cvSkillScale.key };
    });
}
