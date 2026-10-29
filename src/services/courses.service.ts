import type { CoursesPage, CoursesQuery } from '../models/courses.js';
import type { CoursesRepository } from '../repositories/courses.repository.js';

export function createCoursesService(repository: CoursesRepository) {
    return {
        async getPage(query: CoursesQuery): Promise<CoursesPage> {
            const result = await repository.findPage(query);
            return {
                items: result.items.map(course => ({
                    id: String(course.id),
                    title: course.title,
                    url: course.url,
                    platform: course.platform,
                    logoUrl: course.logo_url,
                    durationHours: course.duration_hours,
                    isPaid: course.is_paid,
                    skills: course.skills,
                })),
                page: query.page,
                pageSize: query.pageSize,
                totalRecords: result.totalRecords,
            };
        },
    };
}

export type CoursesService = ReturnType<typeof createCoursesService>;
