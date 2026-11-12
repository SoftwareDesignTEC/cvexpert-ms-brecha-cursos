import { adaptJobSkillsGapInput } from '../adapters/job-skills-gap-input.js';
import { compareJobSkills } from '../domain/job-skills-gap.js';
import { assessJobSkillLevels } from '../domain/job-required-skill-levels.js';

export function evaluateJobSkillsGap(body: unknown, analyzeLevels = true) {
    const { cvId, documentedSkills, offers } = adaptJobSkillsGapInput(body, analyzeLevels);
    return {
        cvId,
        dataSource: 'client_request' as const,
        results: offers.map(({ jobId, requirements, text }) => ({
            jobId,
            ...compareJobSkills(documentedSkills, requirements),
            ...(text === undefined ? {} : assessJobSkillLevels(documentedSkills, requirements, text)),
        })),
    };
}
