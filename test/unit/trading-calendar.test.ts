import { describe, expect, it } from 'vitest';
import { ChineseTradingCalendar } from '../../src/trading-calendar';

describe('ChineseTradingCalendar (default)', () => {
  const calendar = new ChineseTradingCalendar();

  it('treats weekdays as trading days', () => {
    expect(calendar.isTradingDay(new Date('2024-01-02T00:00:00Z'))).toBe(true);
  });

  it('treats weekends as non-trading days', () => {
    expect(calendar.isTradingDay(new Date('2024-01-06T00:00:00Z'))).toBe(false);
    expect(calendar.isTradingDay(new Date('2024-01-07T00:00:00Z'))).toBe(false);
  });
});
