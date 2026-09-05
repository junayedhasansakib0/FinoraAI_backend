import type { Request, Response } from 'express';

import { sendSuccess } from '../../lib/api-response.js';
import { getHealthStatus } from './health.service.js';

export function getHealth(_req: Request, res: Response): void {
  sendSuccess(res, 200, getHealthStatus());
}
