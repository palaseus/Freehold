import { Body, Controller, Get, HttpCode, Param, ParseUUIDPipe, Post, Query, Res, UseGuards } from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import type { FastifyReply } from 'fastify';
import type { Principal } from '../auth/auth.types';
import { AdminGuard, CsrfGuard, SessionGuard } from '../auth/auth.guards';
import { CurrentPrincipal, IdempotencyKey } from '../common/http';
import { ComplianceLinkDto, ComplianceNoteDto, ComplianceOpenDto, ComplianceTransitionDto, IncidentActionDto, IncidentOpenDto, LimitQueryDto, RiskPolicyRequestDto } from './operations.dto';
import { OperationsService } from './operations.service';

@ApiTags('admin') @Controller('admin') @UseGuards(SessionGuard, CsrfGuard, AdminGuard)
export class OperationsController {
  constructor(private readonly operations: OperationsService) {}

  @Get('operations')
  @ApiOperation({ summary: 'Read the current institutional operations report. Unavailable external evidence stays unavailable.' })
  operationsReport(@CurrentPrincipal() principal: Principal) { return this.operations.report(principal); }

  @Get('operations/health')
  @ApiOperation({ summary: 'Read measured worker and outbox health. Backup and verifier evidence stay unavailable unless stored.' })
  health(@CurrentPrincipal() principal: Principal) { return this.operations.health(principal); }

  @Get('deployment')
  @ApiOperation({ summary: 'Read evidence-based deployment status. A listening API is not READY.' })
  deployment(@CurrentPrincipal() principal: Principal) { return this.operations.deployment(principal); }

  @Get('gl/:kind')
  @ApiOperation({ summary: 'Read-only general ledger presentation. Missing sources are NOT_AVAILABLE. This is not a regulatory filing.' })
  gl(@CurrentPrincipal() principal: Principal, @Param('kind') kind: string, @Query('currency') currency?: string) {
    return this.operations.gl(principal, kind.toUpperCase().replaceAll('-', '_'), currency);
  }

  @Get('reports/institutional')
  report(@CurrentPrincipal() principal: Principal) { return this.operations.report(principal); }

  @Get('reports/institutional.csv')
  async reportCsv(@CurrentPrincipal() principal: Principal, @Res({ passthrough: false }) reply: FastifyReply) {
    const body = await this.operations.reportCsv(principal);
    reply.header('content-disposition', 'attachment; filename="institutional-report.csv"');
    reply.type('text/csv; charset=utf-8').send(body);
  }

  @Get('risk/flags')
  flags(@CurrentPrincipal() principal: Principal, @Query() query: LimitQueryDto) { return this.operations.flags(principal, query.limit); }

  @Get('risk/policies')
  policies(@CurrentPrincipal() principal: Principal) { return this.operations.policies(principal); }

  @Post('risk/policy-requests') @HttpCode(200)
  @ApiOperation({ summary: 'Request a dual-controlled risk policy change. Execution requires a separate institutional approver.' })
  requestPolicy(@CurrentPrincipal() principal: Principal, @Body() dto: RiskPolicyRequestDto, @IdempotencyKey() key: string) {
    return this.operations.requestPolicy(principal, dto.parameters, dto.reason, key);
  }

  @Get('compliance/cases')
  cases(@CurrentPrincipal() principal: Principal, @Query() query: LimitQueryDto) { return this.operations.cases(principal, query.limit); }

  @Post('compliance/cases') @HttpCode(200)
  openCase(@CurrentPrincipal() principal: Principal, @Body() dto: ComplianceOpenDto) { return this.operations.openCase(principal, dto); }

  @Get('compliance/cases/:id')
  caseDetail(@CurrentPrincipal() principal: Principal, @Param('id', ParseUUIDPipe) id: string) { return this.operations.caseDetail(principal, id); }

  @Post('compliance/cases/:id/transition') @HttpCode(200)
  transition(@CurrentPrincipal() principal: Principal, @Param('id', ParseUUIDPipe) id: string, @Body() dto: ComplianceTransitionDto) {
    return this.operations.transition(principal, id, dto);
  }

  @Post('compliance/cases/:id/notes') @HttpCode(200)
  note(@CurrentPrincipal() principal: Principal, @Param('id', ParseUUIDPipe) id: string, @Body() dto: ComplianceNoteDto) {
    return this.operations.addNote(principal, id, dto);
  }

  @Post('compliance/cases/:id/links') @HttpCode(200)
  link(@CurrentPrincipal() principal: Principal, @Param('id', ParseUUIDPipe) id: string, @Body() dto: ComplianceLinkDto) {
    return this.operations.link(principal, id, dto);
  }

  @Post('monitor/evaluate') @HttpCode(200)
  @ApiOperation({ summary: 'Record operational alerts. Does not edit financial records or replace the independent verifier.' })
  evaluate(@CurrentPrincipal() principal: Principal) { return this.operations.evaluateMonitor(principal); }

  @Get('monitor/alerts')
  alerts(@CurrentPrincipal() principal: Principal, @Query() query: LimitQueryDto) { return this.operations.alerts(principal, query.limit); }

  @Post('monitor/alerts/:id/acknowledge') @HttpCode(200)
  acknowledge(@CurrentPrincipal() principal: Principal, @Param('id', ParseUUIDPipe) id: string) {
    return this.operations.acknowledgeAlert(principal, id);
  }

  @Post('incidents') @HttpCode(200)
  @ApiOperation({ summary: 'Open an operational incident. This is not a customer compliance case.' })
  openIncident(@CurrentPrincipal() principal: Principal, @Body() dto: IncidentOpenDto) { return this.operations.openIncident(principal, dto); }

  @Get('incidents')
  incidents(@CurrentPrincipal() principal: Principal, @Query() query: LimitQueryDto) { return this.operations.incidents(principal, query.limit); }

  @Get('incidents/:id')
  incident(@CurrentPrincipal() principal: Principal, @Param('id', ParseUUIDPipe) id: string) { return this.operations.incident(principal, id); }

  @Post('incidents/:id/actions') @HttpCode(200)
  incidentAction(@CurrentPrincipal() principal: Principal, @Param('id', ParseUUIDPipe) id: string, @Body() dto: IncidentActionDto) {
    return this.operations.incidentAction(principal, id, dto);
  }
}
