import request from 'supertest';
import { describe, expect, it } from 'vitest';

import { createApp } from '../src/app.js';
import type { ErrorBody, SuccessBody } from '../src/lib/api-response.js';
import type { HealthStatus } from '../src/modules/health/health.service.js';

const app = createApp();

describe('GET /health', () => {
  it('reports service health in the success envelope', async () => {
    const response = await request(app).get('/health');
    const body = response.body as SuccessBody<HealthStatus>;

    expect(response.status).toBe(200);
    expect(body.success).toBe(true);
    expect(body.data.status).toBe('ok');
    expect(typeof body.data.uptimeSeconds).toBe('number');
    expect(Number.isNaN(Date.parse(body.data.timestamp))).toBe(false);
  });

  it('is reachable under the versioned API base path', async () => {
    const response = await request(app).get('/api/v1/health');
    const body = response.body as SuccessBody<HealthStatus>;

    expect(response.status).toBe(200);
    expect(body.data.status).toBe('ok');
  });

  it('does not advertise the server technology', async () => {
    const response = await request(app).get('/health');

    expect(response.headers['x-powered-by']).toBeUndefined();
  });
});

describe('error envelope', () => {
  it('answers unknown routes with NOT_FOUND', async () => {
    const response = await request(app).get('/api/v1/nothing-here');
    const body = response.body as ErrorBody;

    expect(response.status).toBe(404);
    expect(body).toEqual({
      success: false,
      error: { code: 'NOT_FOUND', message: 'Resource not found.' },
    });
  });

  it('answers malformed JSON bodies with VALIDATION_ERROR', async () => {
    const response = await request(app)
      .post('/api/v1/health')
      .set('Content-Type', 'application/json')
      .send('{"broken"');
    const body = response.body as ErrorBody;

    expect(response.status).toBe(400);
    expect(body.success).toBe(false);
    expect(body.error.code).toBe('VALIDATION_ERROR');
  });
});
