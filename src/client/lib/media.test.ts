import { describe, expect, it } from 'vitest';
import { fitWithin } from './media';

describe('fitWithin', () => {
  it('leaves an image already within bounds untouched', () => {
    expect(fitWithin(800, 600)).toEqual({ width: 800, height: 600 });
  });

  it('downscales a landscape image to the max on its long edge', () => {
    expect(fitWithin(3200, 2400)).toEqual({ width: 1600, height: 1200 });
  });

  it('downscales a portrait image to the max on its long edge', () => {
    expect(fitWithin(2400, 3200)).toEqual({ width: 1200, height: 1600 });
  });

  it('respects a custom max', () => {
    expect(fitWithin(1000, 500, 400)).toEqual({ width: 400, height: 200 });
  });
});
