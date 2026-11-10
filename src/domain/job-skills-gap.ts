import type { CvSkillLevel } from './cv-skill-v1.js';

export interface JobSkillRequirement {
    key: string;
    name: string;
}

export function compareJobSkills(
    documentedSkills: ReadonlyMap<string, CvSkillLevel>,
    requirements: readonly JobSkillRequirement[],
) {
    const matchedSkills: { name: string; cvLevel: CvSkillLevel }[] = [];
    const notDocumentedSkills: string[] = [];
    for (const { key, name } of requirements) {
        const cvLevel = documentedSkills.get(key);
        if (cvLevel === undefined) notDocumentedSkills.push(name);
        else matchedSkills.push({ name, cvLevel });
    }

    const requiredSkillsCount = requirements.length;
    const documentedMatchesCount = matchedSkills.length;
    const status = requiredSkillsCount === 0 ? 'insufficient_information'
        : notDocumentedSkills.length === 0 ? 'complete' : 'partial';
    return {
        status,
        requiredSkillsCount,
        documentedMatchesCount,
        documentedCoveragePercent: requiredSkillsCount === 0 ? null
            : Math.round(documentedMatchesCount * 10000 / requiredSkillsCount) / 100,
        matchedSkills,
        notDocumentedSkills,
    };
}
