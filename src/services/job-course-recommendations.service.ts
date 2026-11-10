import { normalizeJobSkillName } from '../domain/job-skills-gap.js';
import type { CatalogSkillMatch, JobCourseRecommendationsRepository } from '../repositories/job-course-recommendations.repository.js';
import { evaluateJobSkillsGap } from './job-skills-gap.service.js';

export class RecommendationCatalogUnavailable extends Error {}

export function createJobCourseRecommendationsService(repository: JobCourseRecommendationsRepository) {
    return async (body: unknown) => {
        const evaluation = evaluateJobSkillsGap(body);
        const missingByOffer = evaluation.results.map(result => result.notDocumentedSkills.map(normalizeJobSkillName));
        const keys = new Set(missingByOffer.flatMap(skills => skills.map(skill => skill.key)));
        let matches: ReadonlyMap<string, CatalogSkillMatch> = new Map();
        if (keys.size > 0) {
            try {
                matches = await repository.findBySkillKeys(keys);
            } catch {
                throw new RecommendationCatalogUnavailable();
            }
        }
        return {
            ...evaluation,
            catalogStatus: keys.size === 0 ? 'not_needed' as const : 'consulted' as const,
            results: evaluation.results.map((result, index) => ({
                ...result,
                recommendations: missingByOffer[index]!.map(({ name, key }) => ({
                    skillName: name,
                    ...(matches.get(key) ?? { catalogMatch: 'not_found' as const, courses: [] }),
                })),
            })),
        };
    };
}
