import { createPool, MIGRATIONS_FOLDER, migrateSchema } from './index';
import { loadConfig, toDbConfig } from '../config';

async function main() {
  const config = loadConfig();
  const pool = createPool(toDbConfig(config));
  try {
    await migrateSchema(pool, MIGRATIONS_FOLDER, 'public');
    console.log('migrations applied');
  } finally {
    await pool.end();
  }
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
