import { describe, expect, it } from 'vitest';
import { SystemClock } from '../../src/clock';

describe('SystemClock', () => {
  it('returns a date close to now', () => {
    const before = Date.now();
    const time = new SystemClock().now().getTime();
    const after = Date.now();
    expect(time).toBeGreaterThanOrEqual(before);
    expect(time).toBeLessThanOrEqual(after);
  });
});
