import { Router } from 'express';
import { createCoursesController } from '../controllers/courses.controller.js';
import type { CoursesService } from '../services/courses.service.js';

export function createCoursesRouter(service: CoursesService) {
    const router = Router();
    router.get('/courses', createCoursesController(service));
    return router;
}
