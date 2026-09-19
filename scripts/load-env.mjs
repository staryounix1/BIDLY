/**
 * Load environment variables for CLI scripts.
 *
 * Order of precedence (later wins): `.env` -> `.env.local` -> real process
 * environment. Values already present in the shell are never overwritten, so
 * CI and hosting providers always take priority over local files.
 */
import { existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import dotenv from 'dotenv';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');

for (const file of ['.env', '.env.local']) {
  const path = join(root, file);
  if (existsSync(path)) dotenv.config({ path, override: false });
}
