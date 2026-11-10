import path from 'node:path';
import dotenv from 'dotenv';

dotenv.config({ path: path.resolve(__dirname, '../../.env') });

const withDb = (url: string, db: string) => {
  const u = new URL(url);
  u.pathname = `/${db}`;
  return u.toString();
};

const admin = process.env.DATABASE_ADMIN_URL ?? 'postgres://postgres:postgres@localhost:5432/smarterp';
const app = process.env.DATABASE_URL ?? 'postgres://smarterp_app:change-me-app-password@localhost:5432/smarterp';

export const TEST_DB = 'smarterp_test';
export const testUrls = {
  maintenance: withDb(admin, 'postgres'),
  admin: withDb(admin, TEST_DB),
  app: withDb(app, TEST_DB),
};
