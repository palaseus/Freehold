import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { ArrayNotEmpty, IsArray, IsIn, IsInt, IsOptional, IsString, IsUUID, Matches, Max, MaxLength, Min } from 'class-validator';

const amount = /^(0|[1-9][0-9]{0,18})$/;
const positive = /^[1-9][0-9]{0,18}$/;
const idempotencyKey = /^[A-Za-z0-9:._-]{8,80}$/;
const code = /^[a-z0-9-]{3,40}$/;
const day = /^\d{4}-\d{2}-\d{2}$/;
const scopes = [
  'accounts:read', 'accounts:write', 'transfers:write', 'payments:write', 'payments:read',
  'treasury:read', 'reserves:read', 'compliance:write', 'governance:write', 'webhooks:write',
  'billing:read', 'reports:read',
] as const;
const rails = ['ACH', 'FEDWIRE', 'BANK_INTERNAL', 'RTP', 'STABLECOIN_NETWORK'] as const;
const states = [
  'CREATED', 'VALIDATING', 'PENDING_APPROVAL', 'READY_TO_SUBMIT', 'SUBMITTED', 'ACKNOWLEDGED',
  'PENDING_SETTLEMENT', 'SETTLED', 'RETURNED', 'REJECTED', 'FAILED', 'UNKNOWN', 'CANCELLED',
] as const;
const capabilities = ['TENANT_ADMIN', 'TREASURY', 'PAYMENTS', 'COMPLIANCE', 'GOVERNANCE', 'AUDITOR', 'DEVELOPER'] as const;
const treasuryKinds = ['RESERVE', 'SETTLEMENT_RECEIVABLE', 'SETTLEMENT_PAYABLE'] as const;
const scenarios = [
  'NORMAL_REDEMPTION', 'ELEVATED_REDEMPTION', 'LARGE_REDEMPTION_SHOCK', 'CUSTODIAN_OUTAGE',
  'SETTLEMENT_DELAY', 'RESERVE_INELIGIBILITY', 'MARKET_VALUE_DECLINE', 'COUNTERPARTY_DEFAULT',
] as const;
const meters = ['API_CALL', 'TRANSACTION', 'COMPLIANCE_TOOL', 'REPORT', 'TENANT', 'CREDIT'] as const;
const disputeStates = ['EVIDENCE', 'ASSIGNED', 'ESCALATED', 'RESOLVED'] as const;
const outcomes = ['DELIVERED_SIMULATED', 'FAILED', 'TIMEOUT'] as const;

export class InstitutionOpenDto {
  @ApiProperty() @IsString() @Matches(code) code!: string;
  @ApiProperty() @IsString() @MaxLength(160) legalName!: string;
}
export class InstitutionGrantDto {
  @ApiProperty({ format: 'uuid' }) @IsUUID() institutionId!: string;
  @ApiProperty({ format: 'uuid' }) @IsUUID() memberId!: string;
  @ApiProperty({ enum: capabilities }) @IsIn(capabilities) capability!: string;
}
export class InstitutionPolicyDto {
  @ApiProperty({ format: 'uuid' }) @IsUUID() institutionId!: string;
  @ApiProperty({ enum: ['PAYMENT_APPROVAL_MINOR', 'CUSTODIAN_CONCENTRATION_BPS', 'RATE_PER_MINUTE'] })
  @IsIn(['PAYMENT_APPROVAL_MINOR', 'CUSTODIAN_CONCENTRATION_BPS', 'RATE_PER_MINUTE']) code!: string;
  @ApiProperty() @IsString() @Matches(amount) thresholdMinor!: string;
}
export class CredentialIssueDto {
  @ApiProperty({ format: 'uuid' }) @IsUUID() institutionId!: string;
  @ApiProperty({ isArray: true, enum: scopes }) @IsArray() @ArrayNotEmpty() @IsIn(scopes, { each: true }) scopes!: string[];
  @ApiProperty() @IsInt() @Min(60) @Max(86400) ttlSeconds!: number;
}
export class CredentialRevokeDto {
  @ApiProperty({ format: 'uuid' }) @IsUUID() institutionId!: string;
  @ApiProperty() @IsString() @Matches(/^fh_sandbox_[0-9a-f]{24}$/) keyId!: string;
}
export class CustomerOpenDto {
  @ApiProperty({ format: 'uuid' }) @IsUUID() institutionId!: string;
  @ApiProperty() @IsString() @MaxLength(80) externalRef!: string;
  @ApiProperty() @IsString() @MaxLength(120) displayName!: string;
  @ApiProperty() @IsString() @Matches(/^[A-Z][A-Z0-9]{2,11}$/) currency!: string;
}
export class FundDto {
  @ApiProperty({ format: 'uuid' }) @IsUUID() institutionId!: string;
  @ApiProperty({ format: 'uuid' }) @IsUUID() accountId!: string;
  @ApiProperty() @IsString() @Matches(positive) amountMinor!: string;
  @ApiProperty() @IsString() @Matches(idempotencyKey) idempotencyKey!: string;
}
export class InstitutionTransferDto {
  @ApiProperty({ format: 'uuid' }) @IsUUID() institutionId!: string;
  @ApiProperty({ format: 'uuid' }) @IsUUID() fromAccountId!: string;
  @ApiProperty({ format: 'uuid' }) @IsUUID() toAccountId!: string;
  @ApiProperty() @IsString() @Matches(positive) amountMinor!: string;
  @ApiProperty() @IsString() @Matches(idempotencyKey) idempotencyKey!: string;
  @ApiPropertyOptional({ format: 'uuid' }) @IsOptional() @IsUUID() correlationId?: string;
}
export class TreasuryOpenDto {
  @ApiProperty({ format: 'uuid' }) @IsUUID() institutionId!: string;
  @ApiProperty({ enum: treasuryKinds }) @IsIn(treasuryKinds) kind!: string;
  @ApiProperty() @IsString() @Matches(/^[A-Z][A-Z0-9]{2,11}$/) currency!: string;
  @ApiPropertyOptional() @IsOptional() @IsString() @MaxLength(80) custodianLabel?: string;
}
export class PaymentOpenDto {
  @ApiProperty({ format: 'uuid' }) @IsUUID() institutionId!: string;
  @ApiProperty({ format: 'uuid' }) @IsUUID() accountId!: string;
  @ApiProperty() @IsString() @Matches(positive) amountMinor!: string;
  @ApiProperty({ enum: rails }) @IsIn(rails) rail!: string;
  @ApiProperty() @IsString() @MaxLength(120) externalRef!: string;
  @ApiProperty() @IsString() @Matches(idempotencyKey) idempotencyKey!: string;
  @ApiPropertyOptional({ format: 'uuid' }) @IsOptional() @IsUUID() correlationId?: string;
}
export class PaymentTransitionDto {
  @ApiProperty({ format: 'uuid' }) @IsUUID() institutionId!: string;
  @ApiProperty({ format: 'uuid' }) @IsUUID() paymentId!: string;
  @ApiProperty({ enum: states }) @IsIn(states) state!: string;
  @ApiPropertyOptional() @IsOptional() @IsString() @MaxLength(120) providerEventId?: string;
  @ApiPropertyOptional() @IsOptional() @IsString() @MaxLength(200) signature?: string;
}
export class RiskDto {
  @ApiProperty({ format: 'uuid' }) @IsUUID() institutionId!: string;
  @ApiProperty({ enum: scenarios }) @IsIn(scenarios) scenario!: string;
}
export class WebhookOpenDto {
  @ApiProperty({ format: 'uuid' }) @IsUUID() institutionId!: string;
  @ApiProperty() @IsString() @Matches(/^https:\/\/example\.test\//) url!: string;
}
export class WebhookSubscribeDto {
  @ApiProperty({ format: 'uuid' }) @IsUUID() institutionId!: string;
  @ApiProperty({ format: 'uuid' }) @IsUUID() endpointId!: string;
  @ApiProperty() @IsString() @MaxLength(80) eventType!: string;
}
export class WebhookAttemptDto {
  @ApiProperty({ format: 'uuid' }) @IsUUID() institutionId!: string;
  @ApiProperty({ format: 'uuid' }) @IsUUID() deliveryId!: string;
  @ApiProperty({ enum: outcomes }) @IsIn(outcomes) outcome!: string;
  @ApiPropertyOptional() @IsOptional() @IsString() @MaxLength(80) secret?: string;
}
export class WebhookRotateDto {
  @ApiProperty({ format: 'uuid' }) @IsUUID() institutionId!: string;
  @ApiProperty({ format: 'uuid' }) @IsUUID() endpointId!: string;
}
export class DisputeOpenDto {
  @ApiProperty({ format: 'uuid' }) @IsUUID() institutionId!: string;
  @ApiPropertyOptional({ format: 'uuid' }) @IsOptional() @IsUUID() paymentId?: string;
  @ApiProperty() @IsString() @MaxLength(500) note!: string;
}
export class DisputeNoteDto {
  @ApiProperty({ format: 'uuid' }) @IsUUID() institutionId!: string;
  @ApiProperty({ format: 'uuid' }) @IsUUID() disputeId!: string;
  @ApiProperty() @IsString() @MaxLength(500) note!: string;
}
export class DisputeResolveDto {
  @ApiProperty({ format: 'uuid' }) @IsUUID() institutionId!: string;
  @ApiProperty({ format: 'uuid' }) @IsUUID() disputeId!: string;
  @ApiProperty({ enum: disputeStates }) @IsIn(disputeStates) state!: string;
  @ApiPropertyOptional() @IsOptional() @IsString() @MaxLength(500) resolution?: string;
}
export class AdjustmentProposeDto {
  @ApiProperty({ format: 'uuid' }) @IsUUID() institutionId!: string;
  @ApiPropertyOptional({ format: 'uuid' }) @IsOptional() @IsUUID() disputeId?: string;
  @ApiProperty({ format: 'uuid' }) @IsUUID() debitAccountId!: string;
  @ApiProperty({ format: 'uuid' }) @IsUUID() creditAccountId!: string;
  @ApiProperty() @IsString() @Matches(positive) amountMinor!: string;
}
export class AdjustmentPostDto {
  @ApiProperty({ format: 'uuid' }) @IsUUID() institutionId!: string;
  @ApiProperty({ format: 'uuid' }) @IsUUID() adjustmentId!: string;
}
export class BillingPlanDto {
  @ApiProperty({ format: 'uuid' }) @IsUUID() institutionId!: string;
  @ApiProperty() @IsString() @Matches(amount) monthlyMinor!: string;
  @ApiProperty() @IsString() @Matches(amount) apiCallMinor!: string;
  @ApiProperty() @IsString() @Matches(amount) transactionMinor!: string;
  @ApiProperty() @IsString() @Matches(amount) complianceMinor!: string;
  @ApiProperty() @IsString() @Matches(amount) reportMinor!: string;
}
export class UsageDto {
  @ApiProperty({ format: 'uuid' }) @IsUUID() institutionId!: string;
  @ApiProperty() @IsString() @Matches(day) periodStart!: string;
  @ApiProperty({ enum: meters }) @IsIn(meters) meter!: string;
  @ApiProperty() @IsString() @Matches(amount) quantity!: string;
}
export class InvoiceDto {
  @ApiProperty({ format: 'uuid' }) @IsUUID() institutionId!: string;
  @ApiProperty() @IsString() @Matches(day) periodStart!: string;
}
export class ComplianceDto {
  @ApiProperty({ format: 'uuid' }) @IsUUID() institutionId!: string;
  @ApiProperty() @IsString() @MaxLength(160) subject!: string;
}
export class IssuanceLinkDto {
  @ApiProperty({ format: 'uuid' }) @IsUUID() institutionId!: string;
  @ApiProperty({ format: 'uuid' }) @IsUUID() issuanceId!: string;
}
export class InstitutionActivateDto {
  @ApiPropertyOptional() @IsOptional() @IsString() @MaxLength(200) reason?: string;
}
