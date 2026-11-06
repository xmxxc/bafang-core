/**
 * 按天缓存：条目只在写入它的那一天（Asia/Shanghai 日期，由调用方给出）内有效。
 * 先放在进程内；以后换成 Redis 时，按 `${day}:${key}` 作键、到当天结束过期即可。
 * 条目数有上限，超出时淘汰最早写入的条目，避免大量不同的键撑大内存。
 */
export class DailyCache<V> {
  private day: string | undefined;
  private entries = new Map<string, V>();

  constructor(private readonly maxEntries = 5000) {}

  get(day: string, key: string): V | undefined {
    return day === this.day ? this.entries.get(key) : undefined;
  }

  set(day: string, key: string, value: V): void {
    if (day !== this.day) {
      this.day = day;
      this.entries = new Map();
    }
    this.entries.delete(key);
    this.entries.set(key, value);
    if (this.entries.size > this.maxEntries) {
      const oldest = this.entries.keys().next().value;
      if (oldest !== undefined) this.entries.delete(oldest);
    }
  }
}
