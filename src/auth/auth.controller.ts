import { Body, Controller, Get, HttpCode, Post, Req, Res, UseGuards } from '@nestjs/common';
import { ApiCookieAuth, ApiHeader, ApiOkResponse, ApiTags, ApiUnauthorizedResponse } from '@nestjs/swagger';
import type { FastifyReply, FastifyRequest } from 'fastify';
import { Config } from '../config/config.module';
import { LoginDto, RegisterDto } from './auth.dto';
import { DatabaseService } from '../database/database.service';
import { AuthService } from './auth.service';
import { SessionService } from './session.service';
import { CsrfGuard, OriginGuard, SESSION_COOKIE, SessionGuard } from './auth.guards';
@ApiTags('auth')
@Controller('auth')
export class AuthController {
  constructor(private readonly auth: AuthService, private readonly sessions: SessionService, private readonly config: Config, private readonly db: DatabaseService) {}
  @Post('register') @HttpCode(201) @UseGuards(OriginGuard)
  @ApiOkResponse({ description: 'Create a USER identity. Optional TOTP enrollment requires a matching code.' })
  register(@Body() dto: RegisterDto) { return this.auth.register(dto); }
  @Get('session') @UseGuards(SessionGuard) @ApiCookieAuth('session')
  async session(@Req() req: FastifyRequest) {
    const { user, session } = req.principal!;
    const [email] = await this.db.transaction(req.principal!, client =>
      this.db.read<{ email: string }>('SELECT freehold.auth_user_email($1::uuid) AS email', [user.id], client));
    return { user: { id: user.id, email: email!.email, role: user.role, twoFactorEnabled: user.two_factor_enabled },
      csrfToken: session.csrfToken, expiresAt: new Date(session.expiresAt).toISOString(),
      twoFactorVerifiedAt: session.twoFactorAt === null ? null : new Date(session.twoFactorAt).toISOString(),
      recentTwoFactorUntil: session.twoFactorAt === null ? null : new Date(session.twoFactorAt + this.config.recentTwoFactorMs).toISOString(),
      demoMode: this.config.demoMode };
  }
  @Post('login') @HttpCode(200) @UseGuards(OriginGuard)
  @ApiOkResponse({ description: 'Opaque HttpOnly session cookie and CSRF token. TOTP required if enrolled.' })
  @ApiUnauthorizedResponse({ description: 'Invalid credentials or missing/invalid TOTP.' })
  async login(@Body() dto: LoginDto, @Res({ passthrough: true }) reply: FastifyReply) {
    const { token, record } = await this.auth.login(dto);
    reply.header('Cache-Control', 'no-store');
    reply.setCookie(SESSION_COOKIE, token, { httpOnly: true, secure: this.config.cookieSecure, sameSite: 'strict',
      path: '/', maxAge: this.config.sessionTtlSeconds });
    return { csrfToken: record.csrfToken, expiresAt: new Date(record.expiresAt).toISOString() };
  }
  @Post('logout') @HttpCode(204) @UseGuards(SessionGuard, CsrfGuard)
  @ApiCookieAuth('session') @ApiHeader({ name: 'X-CSRF-Token', required: true })
  async logout(@Req() req: FastifyRequest, @Res({ passthrough: true }) reply: FastifyReply) {
    await this.auth.logout(req.sessionToken!);
    reply.clearCookie(SESSION_COOKIE, { path: '/', secure: this.config.cookieSecure, httpOnly: true, sameSite: 'strict' });
  }
}
