import { createApplication } from './bootstrap';
import { Config } from './config/config.module';
async function main() {
  const app = await createApplication();
  const host = process.env.BIND_HOST ?? '0.0.0.0';
  if (!/^(127\.0\.0\.1|0\.0\.0\.0|::1)$/.test(host)) throw new Error('Invalid BIND_HOST');
  await app.listen(app.get(Config).port, host);
}
main().catch(error => {
  const message = error instanceof Error ? error.message : 'Freehold startup failed';
  console.error(message.includes('://') ? 'Freehold startup failed' : message);
  process.exitCode = 1;
});
