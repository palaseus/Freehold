import { Controller, Get, UseGuards } from '@nestjs/common';
import { ApiCookieAuth, ApiTags } from '@nestjs/swagger';
import { SessionGuard } from '../auth/auth.guards';
import { DatabaseService } from '../database/database.service';
@ApiTags('currencies') @ApiCookieAuth('session') @UseGuards(SessionGuard)
@Controller('currencies')
export class CurrencyController {
  constructor(private readonly db: DatabaseService) {}
  @Get() list() { return this.db.read('SELECT code,name,minor_unit_exponent AS "minorUnitExponent",enabled FROM freehold.currencies ORDER BY code'); }
}
