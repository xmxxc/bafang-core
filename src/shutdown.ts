import type { ServerType } from '@hono/node-server';

/** Stop admission immediately, drain work, then close the database within one deadline. */
export function installShutdownHandlers(
  server: ServerType,
  stopScheduler: () => void | Promise<void>,
  pool: { end(): Promise<void> },
  timeoutMs = 30_000,
): void {
  let shuttingDown = false;
  const shutdown = (signal: NodeJS.Signals) => {
    if (shuttingDown) return;
    shuttingDown = true;
    console.log(`[bafang-core] shutdown started (${signal})`);
    const deadline = setTimeout(() => {
      console.error(`[bafang-core] shutdown timed out after ${timeoutMs}ms`);
      process.exit(1);
    }, timeoutMs);
    void (async () => {
      try {
        const httpClosed = new Promise<void>((resolve, reject) => {
          server.close((error) => (error ? reject(error) : resolve()));
          // Node 20 also reaps idle keep-alive connections in close().
        });
        await Promise.all([httpClosed, stopScheduler()]);
        await pool.end();
        console.log('[bafang-core] shutdown complete');
        clearTimeout(deadline);
      } catch (error) {
        console.error('[bafang-core] shutdown failed', error);
        process.exit(1);
      }
    })();
  };
  // Keep both handlers installed while draining so repeated signals are harmless.
  process.on('SIGTERM', shutdown);
  process.on('SIGINT', shutdown);
}
