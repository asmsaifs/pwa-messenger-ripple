import { describe, expect, it } from 'vitest';
import { fitWithin, rmsBuckets } from './media';

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

describe('rmsBuckets', () => {
  it('returns all-zero buckets for silence', () => {
    const samples = new Float32Array(6400);
    expect(rmsBuckets(samples, 64)).toEqual(new Array(64).fill(0));
  });

  it('returns an empty-input default when there are no samples', () => {
    expect(rmsBuckets(new Float32Array(0), 8)).toEqual(new Array(8).fill(0));
  });

  it('produces the requested bucket count regardless of sample length', () => {
    expect(rmsBuckets(new Float32Array(1000), 64)).toHaveLength(64);
    expect(rmsBuckets(new Float32Array(3), 64)).toHaveLength(64);
  });

  it('clamps a full-scale tone to 100', () => {
    const samples = new Float32Array(1024).fill(1);
    expect(rmsBuckets(samples, 4)).toEqual([100, 100, 100, 100]);
  });

  it('scales a quiet-but-present signal above zero', () => {
    const samples = new Float32Array(1024).fill(0.1);
    const buckets = rmsBuckets(samples, 4);
    expect(buckets.every((b) => b > 0 && b <= 100)).toBe(true);
  });
});
