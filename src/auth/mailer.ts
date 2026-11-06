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
 * 按配置选择发信适配器：配置了 RESEND_API_KEY 就用 Resend；否则用开发模式的假发信。
 * 生产环境缺少 Resend 配置时直接报错，保证假发信绝不会在生产配置下生效。
 */
export function createMailer(config: Config): Mailer {
  if (config.RESEND_API_KEY) {
    if (!config.RESEND_FROM) {
      throw new Error('配置了 RESEND_API_KEY 时必须同时配置 RESEND_FROM');
    }
    return new ResendMailer(config.RESEND_API_KEY, config.RESEND_FROM);
  }
  if (config.NODE_ENV === 'production') {
    throw new Error('生产环境必须配置 RESEND_API_KEY 与 RESEND_FROM，不能用开发发信');
  }
  return new DevLogMailer();
}
