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
