import 'reflect-metadata';
import { randomUUID } from 'node:crypto';
import { ValidationPipe } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { FastifyAdapter, NestFastifyApplication } from '@nestjs/platform-fastify';
import { DocumentBuilder, SwaggerModule } from '@nestjs/swagger';
import cookie from '@fastify/cookie';
import { AppModule } from './app.module';
import { ErrorFilter } from './common/error.filter';
import { requestContext, writeJsonLog } from './common/structured-log';
import { assertPosture } from './config/production-posture';
import { DatabaseService } from './database/database.service';
export async function createApplication() {
  const app = await NestFactory.create<NestFastifyApplication>(AppModule,
    new FastifyAdapter({ bodyLimit: 16 * 1024, trustProxy: false, logger: false,
      genReqId: (req: { headers: { [key: string]: string | string[] | undefined } }) => {
        const incoming = req.headers['x-request-id'];
        return typeof incoming === 'string' && /^[A-Za-z0-9._:-]{8,80}$/.test(incoming) ? incoming : randomUUID();
      } }),
    { logger: ['error', 'warn'], abortOnError: false });
  try {
    await app.register(cookie);
    app.setGlobalPrefix('v1');
    app.useGlobalPipes(new ValidationPipe({ transform: true, whitelist: true, forbidNonWhitelisted: true,
      transformOptions: { enableImplicitConversion: false }, validationError: { target: false, value: false } }));
    app.useGlobalFilters(new ErrorFilter());
    const http = app.getHttpAdapter().getInstance();
    http.addHook('onRequest', (req, _reply, done) => { requestContext.enterWith({ requestId: req.id }); done(); });
    http.addHook('onResponse', async (req, reply) => {
      const route = req.routeOptions?.url ?? String(req.url ?? '').split('?')[0];
      writeJsonLog({ level: reply.statusCode >= 500 ? 'error' : 'info', service: 'api', event: 'http_request',
        request_id: req.id, method: req.method, route, http_status: reply.statusCode, latency_ms: Math.round(reply.elapsedTime) });
    });
    http.addHook('onSend', async (_req, reply, payload) => {
      reply.header('Cache-Control', 'no-store'); reply.header('X-Content-Type-Options', 'nosniff'); return payload;
    });
    const openapi = SwaggerModule.createDocument(app, new DocumentBuilder().setTitle('Freehold API').setVersion('1.0')
      .setDescription('All amounts are strings of integer minor units. Financial responses are returned only after database commit. Admin operations require recent TOTP.')
      .addCookieAuth('freehold_session', { type: 'apiKey', in: 'cookie' }, 'session').build());
    SwaggerModule.setup('docs', app, openapi, { jsonDocumentUrl: 'openapi.json' });
    const database = () => app.get(DatabaseService);
    http.get('/health', async (_req, reply) => {
      reply.header('cache-control', 'no-store');
      return { status: 'live' };
    });
    http.get('/ready', async (_req, reply) => {
      reply.header('cache-control', 'no-store');
      try {
        await database().read('SELECT 1 AS ok');
        const [row] = await database().read<{ posture: { sandboxEnabled?: boolean; demoEnabled?: boolean } }>(
          'SELECT freehold.runtime_posture() AS posture');
        assertPosture(row?.posture);
        return { status: 'accepting' };
      } catch {
        reply.code(503);
        return { status: 'unavailable' };
      }
    });
    app.enableShutdownHooks();
    await app.init();
    await app.getHttpAdapter().getInstance().ready();
    return app;
  } catch (error) {
    await app.close().catch(() => undefined);
    throw error;
  }
}
