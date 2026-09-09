import { Hono } from 'hono';
import { healthResponseSchema } from '../../shared/health';
import type { Env } from '../env';

export const healthRoute = new Hono<{ Bindings: Env }>();

healthRoute.get('/', (c) => {
  const body = healthResponseSchema.parse({
    status: 'ok',
    env: c.env.APP_ENV,
    timestamp: new Date().toISOString(),
  });
  return c.json(body);
});
