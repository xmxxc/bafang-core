export interface TradingCalendar {
  isTradingDay(date: Date): boolean;
}

const weekdayFormatter = new Intl.DateTimeFormat('en-US', {
  timeZone: 'Asia/Shanghai',
  weekday: 'short',
});

export class ChineseTradingCalendar implements TradingCalendar {
  isTradingDay(date: Date): boolean {
    const weekday = weekdayFormatter.format(date);
    return weekday !== 'Sat' && weekday !== 'Sun';
  }
}
