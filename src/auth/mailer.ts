import type { Config } from '../config';

/**
 * 发信适配器：身份服务里负责把验证码发到用户邮箱的出口，测试时整体替换为假发信。
 * 真实实现走 Resend；以后要换国内邮件服务时，只需提供另一个实现。
 */
export interface Mailer {
  sendVerificationCode(email: string, code: string): Promise<void>;
}

/** 开发模式的假发信：只把验证码打到日志，不发送真实邮件。 */
export class DevLogMailer implements Mailer {
  async sendVerificationCode(email: string, code: string): Promise<void> {
    console.log(
      `[bafang-core][dev-mail] 验证码 ${code}（收件人 ${email}），开发模式不发送真实邮件`,
    );
  }
}

/** 未配置发信方式时的占位实现：一旦被调用就报错，绝不把验证码写进日志。 */
export class MissingMailer implements Mailer {
  async sendVerificationCode(): Promise<void> {
    throw new Error(
      '发信适配器未配置：请设置 RESEND_API_KEY/RESEND_FROM 或 MAIL_TRANSPORT=dev-log',
    );
  }
}

/** 通过 Resend API 发信。 */
export class ResendMailer implements Mailer {
  constructor(
    private readonly apiKey: string,
    private readonly from: string,
  ) {}

  async sendVerificationCode(email: string, code: string): Promise<void> {
    const response = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${this.apiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        from: this.from,
        to: email,
        subject: '八方来财登录验证码',
        text: `你的登录验证码是 ${code}，10 分钟内有效。`,
      }),
    });
    if (!response.ok) {
      throw new Error(`Resend 发信失败（HTTP ${response.status}）`);
    }
  }
}

/**
 * 按配置选择发信适配器。发信方式必须显式配置：
 * - 配置了 `RESEND_API_KEY`（非空）→ 用 Resend（必须同时配置 `RESEND_FROM`）；
 * - 否则只有显式配置了 `MAIL_TRANSPORT=dev-log`，或 `NODE_ENV` 明确等于 `development`/`test`
 *   时，才用开发模式的假发信；
 * - 其余情况（例如生产机没设 NODE_ENV、或密钥为空）一律拒绝启动，绝不退回假发信。
 */
export function createMailer(config: Config): Mailer {
  const apiKey = config.RESEND_API_KEY?.trim() || undefined;
  const from = config.RESEND_FROM?.trim() || undefined;
  if (apiKey) {
    if (!from) {
      throw new Error('配置了 RESEND_API_KEY 时必须同时配置 RESEND_FROM');
    }
    return new ResendMailer(apiKey, from);
  }
  if (
    config.MAIL_TRANSPORT === 'dev-log' ||
    config.NODE_ENV === 'development' ||
    config.NODE_ENV === 'test'
  ) {
    return new DevLogMailer();
  }
  throw new Error(
    '未配置发信方式：请设置 RESEND_API_KEY 与 RESEND_FROM，或显式设置 MAIL_TRANSPORT=dev-log（开发用假发信）',
  );
}
