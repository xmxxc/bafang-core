import { serve } from '@hono/node-server';
import { createApp } from './app';
import { createHealthProbe, createPool } from './db';
import { loadConfig, toDbConfig } from './config';

const config = loadConfig();
const pool = createPool(toDbConfig(config));
const app = createApp({ db: createHealthProbe(pool) });

serve({ fetch: app.fetch, port: config.PORT }, (info) => {
  console.log(`bafang-core listening on http://localhost:${info.port}`);
});
