import { adaptJobSkillsGapInput } from '../adapters/job-skills-gap-input.js';
import { compareJobSkills } from '../domain/job-skills-gap.js';

export function evaluateJobSkillsGap(body: unknown) {
    const { cvId, documentedSkills, offers } = adaptJobSkillsGapInput(body);
    return {
        cvId,
        dataSource: 'client_request' as const,
        results: offers.map(({ jobId, requirements }) => ({
            jobId,
            ...compareJobSkills(documentedSkills, requirements),
        })),
    };
}
