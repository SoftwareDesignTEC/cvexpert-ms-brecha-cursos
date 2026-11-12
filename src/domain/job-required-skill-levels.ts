import { cvSkillOrdinal, type CvSkillLevel } from './cv-skill-v1.js';
import { normalizeJobSkillName, type JobSkillRequirement } from './job-skills-gap.js';

export interface JobRequirementText { description?: string; requirements?: readonly string[] }
type Source = 'description' | 'requirements';
type Reason = 'no_explicit_evidence' | 'optional' | 'negated' | 'contradictory' | 'ambiguous';
export interface RequiredSkillLevel {
    requiredLevel: CvSkillLevel | null;
    evidenceSource: Source | null;
    evidenceText: string | null;
    detectionStatus: 'explicit' | 'unknown' | 'conflict';
    reason: Reason | null;
}

const levelWords: Record<string, CvSkillLevel> = {
    basico: 'beginner', basica: 'beginner', principiante: 'beginner', inicial: 'beginner',
    basicos: 'beginner', basicas: 'beginner',
    basic: 'beginner', beginner: 'beginner', foundational: 'beginner',
    intermedio: 'intermediate', intermedia: 'intermediate', intermediate: 'intermediate',
    intermedios: 'intermediate', intermedias: 'intermediate',
    avanzado: 'advanced', avanzada: 'advanced', advanced: 'advanced', experto: 'expert', experta: 'expert', expert: 'expert',
    avanzados: 'advanced', avanzadas: 'advanced', expertos: 'expert', expertas: 'expert',
};
const levelPattern = Object.keys(levelWords).join('|');
const boundary = '[\\p{L}\\p{N}_+#.\\-]';
const escape = (value: string) => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const normalize = (value: string) => normalizeJobSkillName(value).key;
// Small, explicit grammar: adjacency plus competency connectors. Arbitrary prose
// between a skill and an adjective does not establish a required skill level.
const afterSkill = '(?:\\s*[:=(]\\s*|\\s+)(?:(?:con\\s+)?(?:un\\s+)?nivel\\s+|at\\s+(?:(?:an?|the)\\s+)?|is\\s+|debe\\s+ser\\s+)?';
const beforeSkill = '\\s+(?:(?:knowledge|proficiency|competency|skills?|conocimientos?|dominio|competencia|nivel)\\s+)?(?:(?:in|of|en|de)\\s+)?';
const negated = /\b(?:no|not|never|without|sin|neither|non)\b/u;
const optional = /\b(?:deseables?|desead[oa]s?|preferibles?|preferid[oa]s?|preferentemente|opcional(?:es)?|ideal(?:mente)?|valorables?|valora(?:ra|n)?|optional|preferred|preferably|desirable|ideally|bonus|plus|asset|advantageous)\b|nice[\s-]+to[\s-]+have|not\s+(?:required|mandatory)|no\s+(?:es\s+)?(?:obligatorio|requerido)/u;

function* fragments(value: string) {
    let heading: 'optional' | 'negated' | undefined;
    for (const sentence of value.split(/[;!?\r\n]+|\.(?=\s|$)/u)) {
        const normalized = normalize(sentence);
        // Recognize qualifier headings within a single supplied text field.
        if (/^.*:\s*$/u.test(normalized)) {
            heading = optional.test(normalized) ? 'optional' : negated.test(normalized) ? 'negated' : undefined;
            continue;
        }
        const qualifier = heading ?? (optional.test(normalized) ? 'optional' : negated.test(normalized) ? 'negated' : undefined);
        for (const part of sentence.split(/,|\s+(?:y|and|pero|but)\s+/iu)) {
            const fragment = part.trim();
            if (fragment) yield { fragment, qualifier };
        }
    }
}

export function extractRequiredSkillLevel(skill: JobSkillRequirement, text: JobRequirementText): RequiredSkillLevel {
    const unknown = (reason: Reason, conflict = false): RequiredSkillLevel => ({
        requiredLevel: null, evidenceSource: null, evidenceText: null,
        detectionStatus: conflict ? 'conflict' : 'unknown', reason,
    });
    const skillPattern = escape(normalize(skill.name)).replace(/ /g, '\\s+');
    const skillRegex = new RegExp(`(?<!${boundary})${skillPattern}(?!${boundary})`, 'u');
    const adjacent = new RegExp(`(?<!${boundary})(?:${skillPattern}(?!${boundary})${afterSkill}(${levelPattern})\\b|(${levelPattern})${beforeSkill}${skillPattern}(?!${boundary}))`, 'gu');
    const sources: [Source, string][] = [
        ['description', text.description ?? ''],
        ...(text.requirements ?? []).map(value => ['requirements', value] as [Source, string]),
    ];
    const evidence: { level: CvSkillLevel; source: Source; fragment: string }[] = [];
    let excluded: Reason | undefined;
    for (const [source, value] of sources) {
        // Split only at explicit clause boundaries; preserve dots in technologies.
        // Evidence is always an unchanged substring of the supplied text.
        for (const { fragment, qualifier } of fragments(value)) {
            const normalized = normalize(fragment);
            if (!skillRegex.test(normalized)) continue;
            if (fragment.length > 300) continue;
            const mentioned = [...normalized.matchAll(new RegExp(`\\b(${levelPattern})\\b`, 'gu'))];
            if (mentioned.length > 0 && qualifier === 'optional') { excluded ??= 'optional'; continue; }
            if (mentioned.length > 0 && qualifier === 'negated') { excluded = 'negated'; continue; }
            const matches = [...normalized.matchAll(adjacent)];
            if (matches.length === 0) continue;
            const levels = new Set(mentioned.map(match => levelWords[match[1]!]!));
            if (levels.size !== 1) { excluded = 'ambiguous'; continue; }
            for (const match of matches) evidence.push({ level: levelWords[match[1] ?? match[2]!]!, source, fragment });
        }
    }
    if (excluded === 'negated' || excluded === 'ambiguous') return unknown(excluded, true);
    if (new Set(evidence.map(item => item.level)).size > 1) return unknown('contradictory', true);
    const first = evidence[0];
    return first ? {
        requiredLevel: first.level, evidenceSource: first.source, evidenceText: first.fragment,
        detectionStatus: 'explicit', reason: null,
    } : unknown(excluded ?? 'no_explicit_evidence');
}

export function assessJobSkillLevels(documented: ReadonlyMap<string, CvSkillLevel>,
    skills: readonly JobSkillRequirement[], text: JobRequirementText) {
    const skillLevelAssessments = skills.map(skill => {
        const detection = extractRequiredSkillLevel(skill, text);
        const cvLevel = documented.get(skill.key) ?? null;
        const status = cvLevel === null ? 'not_documented' as const
            : detection.requiredLevel === null ? 'unknown_required_level' as const
            : cvSkillOrdinal(cvLevel) < cvSkillOrdinal(detection.requiredLevel) ? 'documented_skill_below_required' as const
            : 'documented_skill_meets_required' as const;
        return { name: skill.name, cvLevel, ...detection, status,
            deficitSteps: cvLevel === null || detection.requiredLevel === null ? null
                : Math.max(0, cvSkillOrdinal(detection.requiredLevel) - cvSkillOrdinal(cvLevel)),
        };
    });
    const count = (status: typeof skillLevelAssessments[number]['status']) => skillLevelAssessments.filter(item => item.status === status).length;
    return { skillLevelAssessments, levelAnalysis: {
        scale: 'cv-skill-v1' as const,
        comparedSkillsCount: count('documented_skill_below_required') + count('documented_skill_meets_required'),
        belowRequiredCount: count('documented_skill_below_required'),
        meetsRequiredCount: count('documented_skill_meets_required'),
        notDocumentedCount: count('not_documented'),
        unknownRequiredLevelCount: count('unknown_required_level'),
        conflictCount: skillLevelAssessments.filter(item => item.detectionStatus === 'conflict').length,
    } };
}

// Pure integration point for a future recommendation policy; no catalog access.
export function selectDocumentedLevelDeficits(assessments: ReturnType<typeof assessJobSkillLevels>['skillLevelAssessments']) {
    return assessments.filter(item => item.status === 'documented_skill_below_required');
}
