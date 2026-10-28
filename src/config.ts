import path from 'node:path';
import dotenv from 'dotenv';

dotenv.config({ path: path.resolve(__dirname, '../../.env') });

const env = process.env;
const isProd = env.NODE_ENV === 'production';

export const config = {
  isProd,
  isTest: env.NODE_ENV === 'test',
  port: Number(env.PORT ?? 4000),
  host: env.HOST ?? '0.0.0.0',
  databaseUrl: env.DATABASE_URL ?? 'postgres://smarterp_app:change-me-app-password@localhost:5432/smarterp',
  databaseAdminUrl: env.DATABASE_ADMIN_URL ?? 'postgres://postgres:postgres@localhost:5432/smarterp',
  dbPoolMax: Number(env.DB_POOL_MAX ?? 20),
  sessionTtlHours: Number(env.SESSION_TTL_HOURS ?? 12),
  cookieSecure: env.COOKIE_SECURE ? env.COOKIE_SECURE === 'true' : isProd,
  trustProxy: env.TRUST_PROXY === 'true',
  loginRateLimit: Number(env.LOGIN_RATE_LIMIT ?? 10),
  jobsEnabled: env.JOBS_ENABLED !== 'false',
  webDist: env.WEB_DIST ?? path.resolve(__dirname, '../../web/dist'),
};
