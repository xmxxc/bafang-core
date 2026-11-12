import net from 'node:net';

/**
 * 测试用的 PostgreSQL TCP 代理：core 的连接池连它，测试从外部制造数据库故障，
 * 只通过 HTTP 观察 core 的行为。
 *
 * - `cut()`：断开所有现有连接，等同 PostgreSQL 终止后端（重启、管理员终止）；
 * - `refuse()` / `restore()`：停止监听，新连接被拒绝；再恢复监听同一端口；
 * - `stall()`：连接保持打开但不再转发任何数据，等同数据库或网络无响应。
 */
export class PgFaultProxy {
  private server: net.Server;
  private readonly sockets = new Set<net.Socket>();
  private stalled = false;
  port = 0;

  constructor(private readonly target: { host: string; port: number }) {
    this.server = this.createServer();
  }

  async start(): Promise<void> {
    await this.listen(0);
    this.port = (this.server.address() as net.AddressInfo).port;
  }

  cut(): void {
    for (const socket of this.sockets) socket.destroy();
    this.sockets.clear();
  }

  async refuse(): Promise<void> {
    this.cut();
    await new Promise<void>((resolve) => this.server.close(() => resolve()));
  }

  async restore(): Promise<void> {
    this.stalled = false;
    this.server = this.createServer();
    await this.listen(this.port);
  }

  stall(): void {
    this.stalled = true;
  }

  async stop(): Promise<void> {
    this.cut();
    if (this.server.listening) {
      await new Promise<void>((resolve) => this.server.close(() => resolve()));
    }
  }

  private listen(port: number): Promise<void> {
    return new Promise((resolve, reject) => {
      this.server.once('error', reject);
      this.server.listen(port, '127.0.0.1', () => {
        this.server.off('error', reject);
        resolve();
      });
    });
  }

  private createServer(): net.Server {
    return net.createServer((client) => {
      this.track(client);
      if (this.stalled) return; // 接受连接但永不应答
      const upstream = net.connect(this.target.port, this.target.host);
      this.track(upstream);
      client.on('data', (chunk) => {
        if (!this.stalled) upstream.write(chunk);
      });
      upstream.on('data', (chunk) => {
        if (!this.stalled) client.write(chunk);
      });
      client.on('close', () => upstream.destroy());
      upstream.on('close', () => client.destroy());
    });
  }

  private track(socket: net.Socket): void {
    this.sockets.add(socket);
    socket.on('error', () => undefined);
    socket.on('close', () => this.sockets.delete(socket));
  }
}
