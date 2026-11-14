import { Body, Controller, Get, HttpCode, Param, ParseUUIDPipe, Post, UseGuards } from '@nestjs/common';
import { ApiCookieAuth, ApiTags } from '@nestjs/swagger';
import type { Principal } from '../auth/auth.types';
import { CsrfGuard, SessionGuard } from '../auth/auth.guards';
import { CurrentPrincipal, IdempotencyKey } from '../common/http';
import { ScheduleCreateDto } from './schedule.dto';
import { ScheduleService } from './schedule.service';

@ApiTags('scheduled-transfers') @ApiCookieAuth('session')
@Controller('scheduled-transfers') @UseGuards(SessionGuard, CsrfGuard)
export class ScheduleController {
  constructor(private readonly schedules: ScheduleService) {}
  @Get() list(@CurrentPrincipal() principal: Principal) { return this.schedules.list(principal); }
  @Post() @HttpCode(200)
  create(@CurrentPrincipal() principal: Principal, @Body() dto: ScheduleCreateDto, @IdempotencyKey() key: string) {
    return this.schedules.create(principal, dto, key);
  }
  @Post(':id/cancel') @HttpCode(200)
  cancel(@CurrentPrincipal() principal: Principal, @Param('id', ParseUUIDPipe) id: string) {
    return this.schedules.cancel(principal, id);
  }
}
