import { Module } from '@nestjs/common';
import { DatabaseModule } from '../database/database.module';
import { AuthController } from './auth.controller';
import { AuthService } from './auth.service';
import { PasswordService } from './password.service';
import { SessionService } from './session.service';
import { TotpService } from './totp.service';
import { SessionGuard, CsrfGuard, OriginGuard, AdminGuard } from './auth.guards';
@Module({ imports: [DatabaseModule], controllers: [AuthController],
  providers: [AuthService, PasswordService, SessionService, TotpService, SessionGuard, CsrfGuard, OriginGuard, AdminGuard],
  exports: [SessionGuard, CsrfGuard, AdminGuard, SessionService, PasswordService, TotpService] })
export class AuthModule {}
