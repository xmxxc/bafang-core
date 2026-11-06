export interface Clock {
  now(): Date;
}

export class SystemClock implements Clock {
  now(): Date {
    return new Date();
  }
}

const shanghaiDateFormatter = new Intl.DateTimeFormat('en-CA', {
  timeZone: 'Asia/Shanghai',
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
});

/** 按 Asia/Shanghai 理解的日历日期，格式 YYYY-MM-DD。 */
export function shanghaiDate(date: Date): string {
  return shanghaiDateFormatter.format(date);
}

const shanghaiTimeFormatter = new Intl.DateTimeFormat('en-US', {
  timeZone: 'Asia/Shanghai',
  hour: 'numeric',
  minute: 'numeric',
  hourCycle: 'h23',
});

/** 按 Asia/Shanghai 理解的当日时刻，以从午夜起算的分钟数表示（0–1439）。 */
export function shanghaiMinutesOfDay(date: Date): number {
  let hour = 0;
  let minute = 0;
  for (const part of shanghaiTimeFormatter.formatToParts(date)) {
    if (part.type === 'hour') hour = Number(part.value);
    if (part.type === 'minute') minute = Number(part.value);
  }
  return hour * 60 + minute;
}
