import { CanActivate, ExecutionContext, Injectable, NotFoundException, UnauthorizedException } from '@nestjs/common';
import { timingSafeEqual } from 'node:crypto';
import type { FastifyRequest } from 'fastify';
import { Config } from '../config/config.module';
@Injectable()
export class DemoGuard implements CanActivate {
  constructor(private readonly config: Config) {}
  canActivate() { if (!this.config.demoMode) throw new NotFoundException('DEMO_DISABLED'); return true; }
}
@Injectable()
export class DemoBootstrapGuard implements CanActivate {
  constructor(private readonly config: Config) {}
  canActivate(context: ExecutionContext) {
    if (!this.config.demoMode) throw new NotFoundException('DEMO_DISABLED');
    const authorization = context.switchToHttp().getRequest<FastifyRequest>().headers.authorization ?? '';
    const provided = Buffer.from(authorization.replace(/^Bearer /, ''));
    const expected = Buffer.from(this.config.demoBootstrapToken);
    if (provided.length !== expected.length || !timingSafeEqual(provided, expected)) throw new UnauthorizedException();
    return true;
  }
}
