import { Type } from 'class-transformer';
import { IsBoolean, IsIn, IsInt, IsOptional, IsString, IsUUID, Length, Max, Min, ValidateNested } from 'class-validator';

const RULES = ['MAX_SINGLE_TRANSFER', 'DAILY_OUTGOING_LIMIT', 'ACCOUNT_TRANSFER_BLOCK', 'VELOCITY_OUTGOING_COUNT', 'FAILED_TRANSFER_BURST', 'UNUSUAL_TRANSFER_SIZE', 'FROZEN_ACCOUNT_RETRY', 'IDEMPOTENCY_CONFLICT_BURST'] as const;

export class RiskPolicyParametersDto {
  @IsIn(['INSTITUTION', 'ACCOUNT']) scope!: 'INSTITUTION' | 'ACCOUNT';
  @IsIn(RULES) ruleCode!: typeof RULES[number];
  @IsBoolean() enabled!: boolean;
  @IsOptional() @IsUUID() accountId?: string;
  @IsOptional() @IsString() @Length(3, 3) currencyCode?: string;
  @IsOptional() @IsString() @Length(1, 19) thresholdMinor?: string;
  @IsOptional() @IsInt() @Min(1) thresholdCount?: number;
  @IsOptional() @IsInt() @Min(1) windowSeconds?: number;
  @IsOptional() @IsInt() @Min(2) @Max(1000) sizeMultiple?: number;
  @IsOptional() @IsIn(['UTC']) timezone?: 'UTC';
}

export class RiskPolicyRequestDto {
  @ValidateNested() @Type(() => RiskPolicyParametersDto) parameters!: RiskPolicyParametersDto;
  @IsString() @Length(1, 1000) reason!: string;
}

export class ComplianceOpenDto {
  @IsString() @Length(1, 2000) summary!: string;
  @IsIn(['LOW', 'MEDIUM', 'HIGH']) severity!: 'LOW' | 'MEDIUM' | 'HIGH';
  @IsOptional() @IsUUID() subjectUserId?: string;
  @IsOptional() @IsUUID() subjectAccountId?: string;
}

export class ComplianceTransitionDto {
  @IsIn(['OPEN', 'UNDER_REVIEW', 'ESCALATED', 'RESOLVED', 'CLOSED']) status!: 'OPEN' | 'UNDER_REVIEW' | 'ESCALATED' | 'RESOLVED' | 'CLOSED';
  @IsOptional() @IsUUID() reviewerId?: string;
}

export class ComplianceNoteDto {
  @IsString() @Length(1, 4000) note!: string;
}

export class ComplianceLinkDto {
  @IsIn(['ACCOUNT', 'USER', 'OPERATION', 'RISK_FLAG', 'EVIDENCE']) linkType!: 'ACCOUNT' | 'USER' | 'OPERATION' | 'RISK_FLAG' | 'EVIDENCE';
  @IsUUID() refId!: string;
  @IsOptional() @IsString() @Length(1, 200) label?: string;
}

export class LimitQueryDto {
  @IsOptional() @Type(() => Number) @IsInt() @Min(1) @Max(200) limit?: number;
}

export class IncidentOpenDto {
  @IsIn(['INFORMATIONAL', 'WARNING', 'HIGH', 'CRITICAL']) severity!: 'INFORMATIONAL' | 'WARNING' | 'HIGH' | 'CRITICAL';
  @IsString() @Length(1, 200) title!: string;
  @IsString() @Length(1, 4000) summary!: string;
}

export class IncidentActionDto {
  @IsIn(['NOTE', 'EVIDENCE', 'LINK_ALERT', 'LINK_OPERATION', 'ASSIGN', 'ESCALATE', 'CONTAIN', 'RESOLVE', 'CLOSE'])
  action!: 'NOTE' | 'EVIDENCE' | 'LINK_ALERT' | 'LINK_OPERATION' | 'ASSIGN' | 'ESCALATE' | 'CONTAIN' | 'RESOLVE' | 'CLOSE';
  @IsOptional() @IsString() @Length(1, 4000) body?: string;
  @IsOptional() @IsUUID() alertId?: string;
  @IsOptional() @IsString() @Length(1, 200) operationRef?: string;
  @IsOptional() @IsUUID() assigneeId?: string;
  @IsOptional() @IsString() @Length(1, 500) evidenceRef?: string;
}
