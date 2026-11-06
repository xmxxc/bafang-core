import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  importHolidays,
  loadHolidays,
  type HolidayEntry,
} from '../../src/trading-calendar/holidays';
import { createTestSchema, dropTestSchema, type TestSchema } from '../support/test-db';

describe('trading calendar import against a real PostgreSQL test database', () => {
  let db: TestSchema;

  beforeEach(async () => {
    db = await createTestSchema();
  });

  afterEach(async () => {
    await dropTestSchema(db);
  });

  const original: HolidayEntry[] = [
    { date: '2026-01-01', name: '元旦' },
    { date: '2026-10-01', name: '国庆节' },
  ];

  it('imports a year and re-importing is idempotent', async () => {
    await importHolidays(db.pool, 2026, original);
    expect(await loadHolidays(db.pool)).toEqual(['2026-01-01', '2026-10-01']);

    await importHolidays(db.pool, 2026, original);
    expect(await loadHolidays(db.pool)).toEqual(['2026-01-01', '2026-10-01']);
  });

  it('rejects a file with duplicate dates and leaves the existing year data intact', async () => {
    await importHolidays(db.pool, 2026, original);

    const duplicated: HolidayEntry[] = [
      { date: '2026-05-01', name: '劳动节' },
      { date: '2026-05-01', name: '劳动节（重复）' },
    ];
    await expect(importHolidays(db.pool, 2026, duplicated)).rejects.toThrow(/重复/);

    expect(await loadHolidays(db.pool)).toEqual(['2026-01-01', '2026-10-01']);
  });

  it('rejects an invalid date format and leaves the existing year data intact', async () => {
    await importHolidays(db.pool, 2026, original);

    const badFormat: HolidayEntry[] = [{ date: '2026/01/01', name: '坏格式' }];
    await expect(importHolidays(db.pool, 2026, badFormat)).rejects.toThrow(/YYYY-MM-DD/);

    expect(await loadHolidays(db.pool)).toEqual(['2026-01-01', '2026-10-01']);
  });

  it('rejects a holiday belonging to another year and leaves the existing year data intact', async () => {
    await importHolidays(db.pool, 2026, original);

    const wrongYear: HolidayEntry[] = [{ date: '2025-01-01', name: '跨年' }];
    await expect(importHolidays(db.pool, 2026, wrongYear)).rejects.toThrow(/2026/);

    expect(await loadHolidays(db.pool)).toEqual(['2026-01-01', '2026-10-01']);
  });

  it('rolls back the delete when the insert fails at the database', async () => {
    await importHolidays(db.pool, 2026, original);

    // Passes validation (unique, valid date, correct year) but violates the NOT NULL on `name`,
    // so the insert fails after the delete ran — the transaction must restore the original data.
    const notNullViolation = [{ date: '2026-05-01', name: null as unknown as string }];
    await expect(importHolidays(db.pool, 2026, notNullViolation)).rejects.toThrow();

    expect(await loadHolidays(db.pool)).toEqual(['2026-01-01', '2026-10-01']);
  });
});
