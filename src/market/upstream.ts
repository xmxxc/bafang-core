/**
 * 统一上游抓取适配器：行情模块访问任何上游都经过这里。
 * 它负责请求头（含 Referer）、超时、重试与响应编码；测试时整体替换为录制样本。
 */

export interface UpstreamRequest {
  url: string;
  /** 上游的防盗链校验依赖 Referer，每个上游各自给出。 */
  referer: string;
  headers?: Record<string, string>;
  /** 响应体编码；省略时取 Content-Type 的 charset，再缺省为 utf-8。 */
  encoding?: string;
}

/** 行情模块实际使用的上游。健康检查按这些名字报告最近一次成功的时间。 */
export const UPSTREAM_SOURCES = ['eastmoney', 'tiantian', 'sina', 'tencent', 'ths'] as const;

export type UpstreamSource = (typeof UPSTREAM_SOURCES)[number];

export interface UpstreamFetcher {
  /** 返回解码后的响应体文本；失败时抛出 UpstreamError。 */
  fetchText(request: UpstreamRequest): Promise<string>;
  /**
   * 上游响应通过各来源的格式校验后，由来源模块调用，报告该上游这一次成功。
   * 可选：录制样本等测试替身可以不实现。
   */
  recordSuccess?(source: UpstreamSource): void;
}

export type UpstreamErrorKind =
  'timeout' | 'network' | 'http_status' | 'empty_body' | 'bad_response';

export class UpstreamError extends Error {
  constructor(
    readonly kind: UpstreamErrorKind,
    message: string,
    readonly status?: number,
  ) {
    super(message);
    this.name = 'UpstreamError';
  }

  get retryable(): boolean {
    if (this.kind === 'http_status') {
      return this.status === 429 || (this.status !== undefined && this.status >= 500);
    }
    return this.kind !== 'bad_response';
  }
}

export interface HttpUpstreamFetcherOptions {
  timeoutMs?: number;
  /** 首次请求之外的重试次数。 */
  retries?: number;
  retryDelayMs?: number;
  userAgent?: string;
}

const DEFAULT_USER_AGENT =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0 Safari/537.36';

export class HttpUpstreamFetcher implements UpstreamFetcher {
  private readonly timeoutMs: number;
  private readonly retries: number;
  private readonly retryDelayMs: number;
  private readonly userAgent: string;

  constructor(options: HttpUpstreamFetcherOptions = {}) {
    this.timeoutMs = options.timeoutMs ?? 5000;
    this.retries = options.retries ?? 2;
    this.retryDelayMs = options.retryDelayMs ?? 300;
    this.userAgent = options.userAgent ?? DEFAULT_USER_AGENT;
  }

  async fetchText(request: UpstreamRequest): Promise<string> {
    let lastError: UpstreamError | undefined;
    for (let attempt = 0; attempt <= this.retries; attempt++) {
      if (attempt > 0) {
        await new Promise((resolve) => setTimeout(resolve, this.retryDelayMs * attempt));
      }
      try {
        return await this.fetchOnce(request);
      } catch (error) {
        lastError = toUpstreamError(error);
        if (!lastError.retryable) break;
      }
    }
    throw lastError ?? new UpstreamError('network', 'upstream request failed');
  }

  private async fetchOnce(request: UpstreamRequest): Promise<string> {
    const response = await fetch(request.url, {
      headers: {
        'User-Agent': this.userAgent,
        Accept: 'application/json, text/plain, */*',
        Referer: request.referer,
        ...request.headers,
      },
      signal: AbortSignal.timeout(this.timeoutMs),
    });
    if (!response.ok) {
      throw new UpstreamError(
        'http_status',
        `upstream responded ${response.status}`,
        response.status,
      );
    }
    const bytes = await response.arrayBuffer();
    const encoding = request.encoding ?? charsetOf(response.headers.get('content-type')) ?? 'utf-8';
    const text = decode(bytes, encoding);
    if (text.trim() === '') {
      throw new UpstreamError('empty_body', 'upstream returned an empty body');
    }
    return text;
  }
}

function charsetOf(contentType: string | null): string | undefined {
  const match = contentType?.match(/charset=([^;]+)/i);
  return match?.[1]?.trim().replace(/^"|"$/g, '');
}

function decode(bytes: ArrayBuffer, encoding: string): string {
  try {
    return new TextDecoder(encoding).decode(bytes);
  } catch {
    throw new UpstreamError('bad_response', `unsupported encoding ${encoding}`);
  }
}

function toUpstreamError(error: unknown): UpstreamError {
  if (error instanceof UpstreamError) return error;
  if (error instanceof Error && (error.name === 'TimeoutError' || error.name === 'AbortError')) {
    return new UpstreamError('timeout', 'upstream request timed out');
  }
  return new UpstreamError('network', error instanceof Error ? error.message : 'network error');
}
