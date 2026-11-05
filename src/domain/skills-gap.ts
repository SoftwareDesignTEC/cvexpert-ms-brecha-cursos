import type { CatalogCourse } from '../models/courses.js';

// Acuerdo suministrado por el llamador interno, nunca una escala predeterminada.
// levels enumera valores de menor a mayor competencia, no porcentajes.
export interface LevelScale { key: string; levels: readonly number[] }
export interface UserSkill { skillName: string; level: number | null; scaleKey: string | null }
export interface MarketRequirement extends UserSkill {
    sourceReference: string;
    observedAt: string;
    dataKind: 'reference' | 'demo';
}
export interface Gap {
    skillName: string;
    userLevel: number;
    marketLevel: number;
    deficitSteps: number;
    courses: CatalogCourse[];
}
export type UnresolvedReason = 'MISSING_USER_SKILL' | 'MISSING_MARKET_REQUIREMENT'
    | 'UNKNOWN_LEVEL' | 'UNKNOWN_SCALE' | 'SCALE_MISMATCH';
export interface Analysis {
    gaps: Gap[];
    unresolved: { skillName: string; reason: UnresolvedReason; userLevel: number | null; marketLevel: number | null }[];
    comparedSkills: number;
    // empty/incomplete no significan que el usuario cumpla los requisitos.
    status: 'empty' | 'incomplete' | 'complete';
}
export class InvalidAnalysisInput extends Error {
    constructor() { super('Datos de análisis inválidos o contradictorios.'); }
}
const compareText = (a: string, b: string) => a < b ? -1 : a > b ? 1 : 0;
export function requireText(value: string): void {
    if (typeof value !== 'string' || !value || value !== value.trim() || value.includes('\0')) throw new InvalidAnalysisInput();
}
const integer = (value: number) => Number.isInteger(value) && value >= -2147483648 && value <= 2147483647;

function indexSkills<T extends UserSkill>(items: readonly T[]): Map<string, T> {
    const indexed = new Map<string, T>();
    for (const item of items) {
        requireText(item.skillName);
        if (item.scaleKey !== null) requireText(item.scaleKey);
        if (item.level !== null && !integer(item.level)) throw new InvalidAnalysisInput();
        const prior = indexed.get(item.skillName);
        // Duplicados idénticos son inocuos. Conflictos no se resuelven inventando un máximo.
        if (prior && (prior.level !== item.level || prior.scaleKey !== item.scaleKey)) throw new InvalidAnalysisInput();
        indexed.set(item.skillName, item);
    }
    return indexed;
}

export function analyzeSkillsGap(input: {
    scale: LevelScale;
    userSkills: readonly UserSkill[];
    requirements: readonly MarketRequirement[];
    courses: readonly CatalogCourse[];
}): Analysis {
    const { scale } = input;
    requireText(scale.key);
    if (scale.levels.length < 2 || scale.levels.some(value => !integer(value))
        || new Set(scale.levels).size !== scale.levels.length) throw new InvalidAnalysisInput();
    const rank = new Map(scale.levels.map((value, index) => [value, index]));
    const users = indexSkills(input.userSkills);
    const market = indexSkills(input.requirements);
    const provenance = new Map<string, string>();
    for (const requirement of input.requirements) {
        requireText(requirement.sourceReference);
        if (typeof requirement.observedAt !== 'string' || !Number.isFinite(Date.parse(requirement.observedAt))
            || requirement.dataKind !== 'reference' || requirement.skillName.includes('[DEMO]')) throw new InvalidAnalysisInput();
        const signature = JSON.stringify([requirement.sourceReference, requirement.observedAt, requirement.dataKind]);
        if (provenance.has(requirement.skillName) && provenance.get(requirement.skillName) !== signature) throw new InvalidAnalysisInput();
        provenance.set(requirement.skillName, signature);
    }
    for (const skill of [...users.values(), ...market.values()]) {
        if (skill.scaleKey === scale.key && skill.level !== null && !rank.has(skill.level)) throw new InvalidAnalysisInput();
    }
    const result: Analysis = { gaps: [], unresolved: [], comparedSkills: 0, status: 'empty' };
    const names = [...new Set([...users.keys(), ...market.keys()])].sort(compareText);
    for (const skillName of names) {
        const user = users.get(skillName), requirement = market.get(skillName);
        const reason: UnresolvedReason | undefined = !user ? 'MISSING_USER_SKILL'
            : !requirement ? 'MISSING_MARKET_REQUIREMENT'
            : user.level === null || requirement.level === null ? 'UNKNOWN_LEVEL'
            : user.scaleKey === null || requirement.scaleKey === null ? 'UNKNOWN_SCALE'
            : user.scaleKey !== scale.key || requirement.scaleKey !== scale.key ? 'SCALE_MISMATCH' : undefined;
        if (reason) {
            result.unresolved.push({ skillName, reason, userLevel: user?.level ?? null, marketLevel: requirement?.level ?? null });
            continue;
        }
        result.comparedSkills++;
        const userLevel = user!.level!, marketLevel = requirement!.level!;
        const deficitSteps = rank.get(marketLevel)! - rank.get(userLevel)!;
        if (deficitSteps > 0) result.gaps.push({ skillName, userLevel, marketLevel, deficitSteps, courses: [] });
    }
    result.gaps.sort((a, b) => b.deficitSteps - a.deficitSteps || compareText(a.skillName, b.skillName));
    // Criterio de pertinencia: asociación exacta a una brecha. ID solo desempata,
    // no demuestra calidad, eficacia, nivel enseñado ni afinidad personalizada.
    const courses = new Map<string, CatalogCourse>();
    for (const course of input.courses) {
        if (!/^[1-9][0-9]*$/.test(course.id) || BigInt(course.id) > 2147483647n
            || (course.durationHours !== null && (!integer(course.durationHours) || course.durationHours < 0))) throw new InvalidAnalysisInput();
        const normalized = { ...course, skills: [...new Set(course.skills)].sort(compareText) };
        const prior = courses.get(course.id);
        const signature = (c: CatalogCourse) => JSON.stringify([c.id, c.title, c.url, c.platform, c.logoUrl, c.durationHours, c.isPaid, c.skills]);
        if (prior && signature(prior) !== signature(normalized)) throw new InvalidAnalysisInput();
        courses.set(course.id, normalized);
    }
    const ordered = [...courses.values()].sort((a, b) => Number(a.id) - Number(b.id));
    const assigned = new Set<string>();
    for (const gap of result.gaps) {
        gap.courses = ordered.filter(course => {
            if (assigned.has(course.id) || [course.title, course.platform, ...course.skills].some(text => text.includes('[DEMO]'))
                || !course.skills.includes(gap.skillName)) return false;
            assigned.add(course.id);
            return true;
        });
    }
    result.status = names.length === 0 ? 'empty' : result.unresolved.length > 0 ? 'incomplete' : 'complete';
    return result;
}
