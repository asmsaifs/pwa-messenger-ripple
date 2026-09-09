import { SELF } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';
import { healthResponseSchema } from '../shared/health';

describe('GET /api/health', () => {
  it('returns ok status matching the shared schema', async () => {
    const res = await SELF.fetch('https://example.com/api/health');
    expect(res.status).toBe(200);

    const body = healthResponseSchema.parse(await res.json());
    expect(body.status).toBe('ok');
    expect(body.env).toBe('local');
  });
});
