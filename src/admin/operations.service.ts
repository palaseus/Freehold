import { Injectable } from '@nestjs/common';
import { assembleDeployment } from './deployment-status';
import { DatabaseService } from '../database/database.service';
import type { Principal } from '../auth/auth.types';
import type { ComplianceLinkDto, ComplianceNoteDto, ComplianceOpenDto, ComplianceTransitionDto, IncidentActionDto, IncidentOpenDto, RiskPolicyParametersDto } from './operations.dto';

const csvCell = (value: unknown) => {
  const text = value == null ? '' : String(value);
  const safe = /^[=+\-@]/.test(text) ? `'${text}` : text;
  return /[",\n\r]/.test(safe) ? `"${safe.replaceAll('"', '""')}"` : safe;
};

export function institutionalCsv(report: {
  liabilities?: Array<{ currency: string; exponent: number; customerLiabilityMinor: string; sandboxFundingIssuedMinor: string }>;
  accounts?: Array<{ currency: string; status: string; count: number }>;
  transfers?: Array<{ currency: string; state: string; count: number; amountMinor: string; exponent: number }>;
  activeHolds?: Array<{ currency: string; count: number; amountMinor: string; exponent: number }>;
  externalAssets?: { status?: string };
}): string {
  const rows: unknown[][] = [['section', 'currency', 'metric', 'amountMinor', 'count', 'exponent']];
  for (const row of report.liabilities ?? []) {
    rows.push(['customer_liability', row.currency, 'customerLiabilityMinor', row.customerLiabilityMinor, '', row.exponent]);
    rows.push(['sandbox_funding_issued', row.currency, 'sandboxFundingIssuedMinor', row.sandboxFundingIssuedMinor, '', row.exponent]);
  }
  for (const row of report.accounts ?? []) rows.push(['accounts', row.currency, row.status, '', row.count, '']);
  for (const row of report.transfers ?? []) rows.push(['transfers', row.currency, row.state, row.amountMinor, row.count, row.exponent]);
  for (const row of report.activeHolds ?? []) rows.push(['active_holds', row.currency, 'ACTIVE', row.amountMinor, row.count, row.exponent]);
  rows.push(['external_assets', '', 'status', '', '', '']);
  rows.push(['external_assets', '', report.externalAssets?.status ?? 'UNAVAILABLE', '', '', '']);
  return `${rows.map(row => row.map(csvCell).join(',')).join('\n')}\n`;
}

@Injectable()
export class OperationsService {
  constructor(private readonly db: DatabaseService) {}
  report(principal: Principal) {
    return this.db.transaction(principal, async client => {
      const [row] = await this.db.read<{ report: Parameters<typeof institutionalCsv>[0] }>(
        'SELECT freehold.institutional_report($1::uuid) AS report', [principal.user.id], client);
      return row!.report;
    }, true);
  }
  async reportCsv(principal: Principal) {
    return institutionalCsv(await this.report(principal));
  }
  health(principal: Principal) {
    return this.db.transaction(principal, async client => {
      const [row] = await this.db.read<{ health: unknown }>('SELECT freehold.operations_health($1::uuid) AS health', [principal.user.id], client);
      return row?.health;
    }, true);
  }
  deployment(principal: Principal) {
    return this.db.transaction(principal, async client => {
      const [row] = await this.db.read<{ posture: Record<string, unknown> | null }>(
        'SELECT freehold.deployment_posture($1::uuid) AS posture', [principal.user.id], client);
      return assembleDeployment(row?.posture ?? null);
    }, true);
  }
  gl(principal: Principal, kind: string, currency?: string) {
    return this.db.transaction(principal, async client => {
      const [row] = await this.db.read<{ report: unknown }>('SELECT freehold.gl_report($1::uuid,$2::text,$3::text) AS report', [principal.user.id, kind, currency ?? ''], client);
      return row?.report;
    }, true);
  }
  flags(principal: Principal, limit = 50) {
    return this.db.transaction(principal, async client => {
      const [row] = await this.db.read<{ flags: unknown }>('SELECT freehold.risk_flags_list($1::uuid,$2::integer) AS flags', [principal.user.id, limit], client);
      return row?.flags ?? [];
    }, true);
  }
  policies(principal: Principal) {
    return this.db.transaction(principal, async client => {
      const [row] = await this.db.read<{ policies: unknown }>('SELECT freehold.risk_policies_list($1::uuid) AS policies', [principal.user.id], client);
      return row?.policies ?? [];
    }, true);
  }
  requestPolicy(principal: Principal, parameters: RiskPolicyParametersDto, reason: string, key: string) {
    return this.db.transaction(principal, async client => {
      const [row] = await this.db.read<{ request: unknown }>(
        'SELECT freehold.governance_create_risk_policy_request($1::uuid,$2::jsonb,$3::text,$4::text) AS request',
        [principal.user.id, JSON.stringify(parameters), reason, key], client);
      return row?.request;
    }, true);
  }
  cases(principal: Principal, limit = 50) {
    return this.db.transaction(principal, async client => {
      const [row] = await this.db.read<{ cases: unknown }>('SELECT freehold.compliance_list($1::uuid,$2::integer) AS cases', [principal.user.id, limit], client);
      return row?.cases ?? [];
    }, true);
  }
  caseDetail(principal: Principal, caseId: string) {
    return this.db.transaction(principal, async client => {
      const [row] = await this.db.read<{ item: unknown }>('SELECT freehold.compliance_get($1::uuid,$2::uuid) AS item', [principal.user.id, caseId], client);
      return row?.item;
    }, true);
  }
  openCase(principal: Principal, dto: ComplianceOpenDto) {
    return this.db.transaction(principal, async client => {
      const [row] = await this.db.read<{ item: unknown }>(
        'SELECT freehold.compliance_open_case($1::uuid,$2::text,$3::text,$4::uuid,$5::uuid) AS item',
        [principal.user.id, dto.summary, dto.severity, dto.subjectUserId ?? null, dto.subjectAccountId ?? null], client);
      return row?.item;
    }, true);
  }
  transition(principal: Principal, caseId: string, dto: ComplianceTransitionDto) {
    return this.db.transaction(principal, async client => {
      const [row] = await this.db.read<{ item: unknown }>(
        'SELECT freehold.compliance_transition($1::uuid,$2::uuid,$3::text,$4::uuid) AS item',
        [principal.user.id, caseId, dto.status, dto.reviewerId ?? null], client);
      return row?.item;
    }, true);
  }
  addNote(principal: Principal, caseId: string, dto: ComplianceNoteDto) {
    return this.db.transaction(principal, async client => {
      const [row] = await this.db.read<{ item: unknown }>(
        'SELECT freehold.compliance_add_note($1::uuid,$2::uuid,$3::text) AS item',
        [principal.user.id, caseId, dto.note], client);
      return row?.item;
    }, true);
  }
  link(principal: Principal, caseId: string, dto: ComplianceLinkDto) {
    return this.db.transaction(principal, async client => {
      const [row] = await this.db.read<{ item: unknown }>(
        'SELECT freehold.compliance_link($1::uuid,$2::uuid,$3::text,$4::uuid,$5::text) AS item',
        [principal.user.id, caseId, dto.linkType, dto.refId, dto.label ?? null], client);
      return row?.item;
    }, true);
  }
  evaluateMonitor(principal: Principal) {
    return this.db.transaction(principal, async client => {
      const [row] = await this.db.read<{ result: unknown }>('SELECT freehold.monitor_evaluate($1::uuid) AS result', [principal.user.id], client);
      return row?.result;
    }, true);
  }
  alerts(principal: Principal, limit = 50) {
    return this.db.transaction(principal, async client => {
      const [row] = await this.db.read<{ alerts: unknown }>('SELECT freehold.alert_list($1::uuid,$2::integer) AS alerts', [principal.user.id, limit], client);
      return row?.alerts ?? [];
    }, true);
  }
  acknowledgeAlert(principal: Principal, alertId: string) {
    return this.db.transaction(principal, async client => {
      const [row] = await this.db.read<{ alert: unknown }>('SELECT freehold.alert_acknowledge($1::uuid,$2::uuid) AS alert', [principal.user.id, alertId], client);
      return row?.alert;
    }, true);
  }
  openIncident(principal: Principal, dto: IncidentOpenDto) {
    return this.db.transaction(principal, async client => {
      const [row] = await this.db.read<{ incident: unknown }>(
        'SELECT freehold.incident_open($1::uuid,$2::text,$3::text,$4::text) AS incident',
        [principal.user.id, dto.severity, dto.title, dto.summary], client);
      return row?.incident;
    }, true);
  }
  incidents(principal: Principal, limit = 50) {
    return this.db.transaction(principal, async client => {
      const [row] = await this.db.read<{ incidents: unknown }>('SELECT freehold.incident_list($1::uuid,$2::integer) AS incidents', [principal.user.id, limit], client);
      return row?.incidents ?? [];
    }, true);
  }
  incident(principal: Principal, incidentId: string) {
    return this.db.transaction(principal, async client => {
      const [row] = await this.db.read<{ incident: unknown }>('SELECT freehold.incident_get($1::uuid,$2::uuid) AS incident', [principal.user.id, incidentId], client);
      return row?.incident;
    }, true);
  }
  incidentAction(principal: Principal, incidentId: string, dto: IncidentActionDto) {
    const payload = {
      body: dto.body ?? null,
      alertId: dto.alertId ?? null,
      operationRef: dto.operationRef ?? null,
      assigneeId: dto.assigneeId ?? null,
      evidenceRef: dto.evidenceRef ?? null,
    };
    return this.db.transaction(principal, async client => {
      const [row] = await this.db.read<{ incident: unknown }>(
        'SELECT freehold.incident_update($1::uuid,$2::uuid,$3::text,$4::jsonb) AS incident',
        [principal.user.id, incidentId, dto.action, JSON.stringify(payload)], client);
      return row?.incident;
    }, true);
  }
}
