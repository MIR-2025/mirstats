// Loads environment from the project's .env, resolved relative to THIS file (not
// the process cwd, so it works under pm2 regardless of where it's launched).
import dotenv from 'dotenv';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = path.join(__dirname, '..');

dotenv.config({ path: path.join(projectRoot, '.env') });
