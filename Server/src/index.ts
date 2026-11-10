import { buildApp } from './app';
import { config } from './config';
import { appPool } from './db/pool';
import { runLowStockJob } from './jobs/lowStock';

async function main() {
  const app = await buildApp();
  await app.listen({ port: config.port, host: config.host });

  let timer: NodeJS.Timeout | undefined;
  if (config.jobsEnabled) {
    const run = () => runLowStockJob().catch((err) => app.log.error(err, 'low stock job failed'));
    setTimeout(run, 10_000);
    timer = setInterval(run, 60 * 60 * 1000);
  }

  const shutdown = async () => {
    if (timer) clearInterval(timer);
    await app.close();
    await appPool.end();
    process.exit(0);
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
