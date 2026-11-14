import { Body, Controller, Get, HttpCode, Param, ParseUUIDPipe, Post, Query, UseGuards } from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import type { Principal } from '../auth/auth.types';
import { AdminGuard, SessionGuard, CsrfGuard } from '../auth/auth.guards';
import { CurrentPrincipal, FinancialApi, IdempotencyKey } from '../common/http';
import { AdminQueryDto } from './admin-query.dto';
import { AdminReasonDto } from './admin.dto';
import { AdminService } from './admin.service';
@ApiTags('admin') @Controller('admin/accounts') @UseGuards(SessionGuard, CsrfGuard, AdminGuard)
export class AdminController {
  constructor(private readonly admin: AdminService) {}
  @Get()
  list(@CurrentPrincipal() principal: Principal, @Query() query: AdminQueryDto) { return this.admin.list(principal, query.query, query.limit); }
  @Post(':id/freeze') @HttpCode(200) @FinancialApi()
  @ApiOperation({ summary: 'Request a dual-controlled account freeze. A separate financial reviewer must approve.' })
  freeze(@CurrentPrincipal() principal: Principal, @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: AdminReasonDto, @IdempotencyKey() key: string) { return this.admin.freeze(principal, id, true, dto.reason, key); }
  @Post(':id/unfreeze') @HttpCode(200) @FinancialApi()
  @ApiOperation({ summary: 'Request a dual-controlled account unfreeze. A separate financial reviewer must approve.' })
  unfreeze(@CurrentPrincipal() principal: Principal, @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: AdminReasonDto, @IdempotencyKey() key: string) { return this.admin.freeze(principal, id, false, dto.reason, key); }
}

@ApiTags('admin') @Controller('admin') @UseGuards(SessionGuard, CsrfGuard, AdminGuard)
export class AdminObservabilityController {
  constructor(private readonly admin: AdminService) {}

  @Get('reconciliation/latest')
  @ApiOperation({ summary: 'Read the latest worker reconciliation report; admin and recent TOTP required.' })
  latest(@CurrentPrincipal() principal: Principal) { return this.admin.latestReconciliation(principal); }

  @Get('audit-events')
  @ApiOperation({ summary: 'Read recent audit events, including high-severity reconciliation mismatches.' })
  audit(@CurrentPrincipal() principal: Principal, @Query() query: AdminQueryDto) {
    return this.admin.auditEvents(principal, query.limit);
  }

  @Get('governance') overview(@CurrentPrincipal() principal: Principal) { return this.admin.overview(principal); }

  @Post('governance/requests/:id/approve') @HttpCode(200)
  approve(@CurrentPrincipal() principal: Principal, @Param('id', ParseUUIDPipe) id: string) { return this.admin.decide(principal,id,'APPROVE'); }

  @Post('governance/requests/:id/reject') @HttpCode(200)
  reject(@CurrentPrincipal() principal: Principal, @Param('id', ParseUUIDPipe) id: string) { return this.admin.decide(principal,id,'REJECT'); }

  @Post('governance/requests/:id/execute') @HttpCode(200) @FinancialApi()
  execute(@CurrentPrincipal() principal: Principal, @Param('id', ParseUUIDPipe) id: string, @IdempotencyKey() key: string) { return this.admin.execute(principal,id,key); }

  @Post('governance/requests/:id/cancel') @HttpCode(200)
  cancel(@CurrentPrincipal() principal: Principal, @Param('id', ParseUUIDPipe) id: string) { return this.admin.cancel(principal,id); }

  @Post('governance/suspend-writes') @HttpCode(200)
  suspend(@CurrentPrincipal() principal: Principal, @Body() dto: AdminReasonDto) { return this.admin.suspend(principal,dto.reason); }

  @Post('governance/resume-requests') @HttpCode(200)
  requestResume(@CurrentPrincipal() principal: Principal, @Body() dto: AdminReasonDto, @IdempotencyKey() key: string) { return this.admin.requestResume(principal,dto.reason,key); }
}
