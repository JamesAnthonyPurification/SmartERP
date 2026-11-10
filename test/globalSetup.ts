import pg from 'pg';
import { migrate } from '../src/db/migrate';
import { TEST_DB, testUrls } from './urls';

/** Recreates the test database from migrations before every test run. */
export default async function setup() {
  const client = new pg.Client({ connectionString: testUrls.maintenance });
  await client.connect();
  await client.query(`DROP DATABASE IF EXISTS ${TEST_DB} WITH (FORCE)`);
  await client.query(`CREATE DATABASE ${TEST_DB}`);
  await client.end();
  await migrate({ adminUrl: testUrls.admin, appUrl: testUrls.app, log: () => undefined });
}
