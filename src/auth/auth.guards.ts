import { CanActivate, ExecutionContext, ForbiddenException, Injectable, UnauthorizedException } from '@nestjs/common';
import { timingSafeEqual } from 'node:crypto';
import type { FastifyRequest } from 'fastify';
import { Config } from '../config/config.module';
import { DatabaseService } from '../database/database.service';
import { SessionService } from './session.service';
import type { AuthUser } from './auth.types';
export const SESSION_COOKIE = 'freehold_session';
@Injectable()
export class SessionGuard implements CanActivate {
  constructor(private readonly sessions: SessionService, private readonly db: DatabaseService) {}
  async canActivate(context: ExecutionContext) {
    const req = context.switchToHttp().getRequest<FastifyRequest>();
    const token = req.cookies[SESSION_COOKIE];
    const session = token ? await this.sessions.load(token) : null;
    if (!token || !session) throw new UnauthorizedException();
    // Always a primary PostgreSQL lookup: Redis is not an authorization cache.
    const [user] = await this.db.read<AuthUser>('SELECT * FROM freehold.auth_get_user($1::uuid)', [session.userId]);
    if (!user || user.status !== 'ACTIVE' || user.auth_version !== session.authVersion ||
      (user.two_factor_enabled && session.twoFactorAt === null)) throw new UnauthorizedException();
    req.principal = { user, session }; req.sessionToken = token;
    return true;
  }
}
@Injectable()
export class OriginGuard implements CanActivate {
  constructor(private readonly config: Config) {}
  canActivate(context: ExecutionContext) {
    const req = context.switchToHttp().getRequest<FastifyRequest>();
    // Reject cross-origin login as well as authenticated CSRF attempts. Nonbrowser
    // clients may omit Origin but authenticated mutations still require a token.
    if (req.headers.origin && req.headers.origin !== this.config.origin) throw new ForbiddenException('ORIGIN_REJECTED');
    return true;
  }
}
@Injectable()
export class CsrfGuard extends OriginGuard {
  constructor(config: Config) { super(config); }
  override canActivate(context: ExecutionContext) {
    super.canActivate(context);
    const req = context.switchToHttp().getRequest<FastifyRequest>();
    if (['GET', 'HEAD', 'OPTIONS'].includes(req.method)) return true;
    const provided = req.headers['x-csrf-token'];
    const expected = req.principal?.session.csrfToken;
    if (typeof provided !== 'string' || !expected || Buffer.byteLength(provided) !== Buffer.byteLength(expected) ||
      !timingSafeEqual(Buffer.from(provided), Buffer.from(expected))) throw new ForbiddenException('CSRF_REJECTED');
    return true;
  }
}
@Injectable()
export class AdminGuard implements CanActivate {
  constructor(private readonly config: Config, private readonly db: DatabaseService) {}
  async canActivate(context: ExecutionContext) {
    const principal = context.switchToHttp().getRequest<FastifyRequest>().principal;
    const at = principal?.session.twoFactorAt;
    if (!principal || principal.user.role !== 'ADMIN' || !principal.user.two_factor_enabled || at == null ||
      Date.now() - at > this.config.recentTwoFactorMs) {
      if (principal) {
        try {
          await this.db.transaction(principal, client => this.db.read(
            "SELECT freehold.governance_record_authorization_failure($1::uuid,'ADMIN_ROUTE',NULL,'ROLE_OR_RECENT_TOTP_REQUIRED')",
            [principal.user.id], client));
        }
        catch { /* denial remains authoritative even if the audit store is unavailable */ }
      }
      throw new ForbiddenException('Recent admin 2FA required');
    }
    return true;
  }
}
