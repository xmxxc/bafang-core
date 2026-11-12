import { copyFile, mkdir, mkdtemp, readFile, readdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { MIGRATIONS_FOLDER } from '../../src/db';

/**
 * 在临时目录里准备只到 journal `idx <= maxIdx` 的旧版迁移目录（SQL、journal 与对应快照），
 * 供迁移升级路径的回归测试建出旧版 schema。调用方用完后自行删除返回的目录。
 */
export async function migrationFolderThrough(maxIdx: number): Promise<string> {
  const folder = await mkdtemp(join(tmpdir(), `migrations-through-${maxIdx}-`));
  const sourceMeta = join(MIGRATIONS_FOLDER, 'meta');
  await mkdir(join(folder, 'meta'));
  const journal = JSON.parse(await readFile(join(sourceMeta, '_journal.json'), 'utf8')) as {
    entries: { idx: number; tag: string }[];
  };
  journal.entries = journal.entries.filter((entry) => entry.idx <= maxIdx);
  await writeFile(join(folder, 'meta/_journal.json'), JSON.stringify(journal));
  for (const entry of journal.entries) {
    await copyFile(join(MIGRATIONS_FOLDER, `${entry.tag}.sql`), join(folder, `${entry.tag}.sql`));
  }
  for (const name of await readdir(sourceMeta)) {
    if (name.endsWith('.json') && name !== '_journal.json' && Number(name.slice(0, 4)) <= maxIdx) {
      await copyFile(join(sourceMeta, name), join(folder, 'meta', name));
    }
  }
  return folder;
}
