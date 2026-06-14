// Morgan access logging to logs/visitors.log, skipping static asset noise.
import morgan from 'morgan';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const logDir = path.join(__dirname, '..', 'logs');
fs.mkdirSync(logDir, { recursive: true });

const logStream = fs.createWriteStream(path.join(logDir, 'visitors.log'), { flags: 'a' });

morgan.token('real-ip', (req) =>
  req.headers['x-forwarded-for'] || req.headers['x-real-ip'] || req.ip
);

const format = ':real-ip - [:date[clf]] ":method :url" :status ":user-agent"';
const skipStatic = (req) => /\.(css|js|png|jpg|jpeg|webp|ico|svg|woff2?)$/i.test(req.url);

export const accessLogger = morgan(format, { stream: logStream, skip: skipStatic });
