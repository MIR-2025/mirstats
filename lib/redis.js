// Redis client + Redis-backed session middleware factory.
import { createClient } from 'redis';
import session from 'express-session';
import { RedisStore } from 'connect-redis';

export const redis = createClient({
  url: process.env.REDIS_URL || 'redis://127.0.0.1:6379',
});
redis.on('error', (err) => console.error('Redis error:', err));

export async function connectRedis() {
  if (!redis.isOpen) await redis.connect();
  console.log('Redis connected');
  return redis;
}

export function sessionMiddleware() {
  return session({
    store: new RedisStore({ client: redis, prefix: 'sess:' }),
    secret: process.env.SESSION_SECRET || 'dev-secret-change-me',
    resave: false,
    saveUninitialized: false,
    cookie: {
      httpOnly: true,
      secure: process.env.NODE_ENV === 'production',
      sameSite: 'lax',
      maxAge: 7 * 24 * 60 * 60 * 1000, // 7 days
    },
  });
}
