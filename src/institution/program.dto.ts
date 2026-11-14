import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { IsArray, IsBoolean, IsInt, IsISO8601, IsObject, IsOptional, IsString, IsUUID, Matches, Max, MaxLength, Min, MinLength } from 'class-validator';

const positive = /^[1-9][0-9]{0,18}$/;
const amount = /^(0|[1-9][0-9]{0,18})$/;
const currency = /^[A-Z]{3}$/;
const keyText = /^[A-Za-z0-9:._-]{8,80}$/;
const codeText = /^[A-Z0-9-]{3,24}$/;
const domainText = /^(PAYMENT|TREASURY|LIQUIDITY|SETTLEMENT|RESERVE|ASSET_TRANSFER|APPROVAL|RISK|ESCROW|ISSUANCE)$/;
const assetType = /^(PAYMENT_STABLECOIN_UNIT|TOKENIZED_DEPOSIT|INSTITUTIONAL_DEBT|SECURITY|RECEIVABLE|COMMODITY_CLAIM)$/;
const movement = /^(SWEEP|FUNDING|RESERVE_ALLOCATION|SCHEDULED|QUEUE_PRIORITY|CONCENTRATION_ALERT|REDEMPTION_FORECAST|CASHFLOW_PROJECTION)$/;
const accountKind = /^(OPERATING|TREASURY|RESERVE|SUSPENSE|SETTLEMENT_RECEIVABLE|SETTLEMENT_PAYABLE)$/;
const quoteKind = /^(FIRM|INDICATIVE)$/;

export class ProgramInstitutionDto {
  @ApiProperty({ format: 'uuid' }) @IsUUID() institutionId!: string;
}
export class ProgramPolicyDraftDto {
  @ApiProperty({ format: 'uuid' }) @IsUUID() institutionId!: string;
  @ApiProperty() @IsString() @Matches(domainText) domain!: string;
  @ApiProperty() @IsObject() body!: Record<string, unknown>;
  @ApiProperty() @IsInt() @Min(0) @Max(1000) precedence!: number;
  @ApiProperty() @IsString() @Matches(positive) maxExposureMinor!: string;
  @ApiProperty() @IsString() @Matches(currency) currency!: string;
  @ApiProperty() @IsISO8601() effectiveFrom!: string;
  @ApiProperty() @IsISO8601() effectiveUntil!: string;
}
export class ProgramPolicyIdDto {
  @ApiProperty({ format: 'uuid' }) @IsUUID() policyId!: string;
}
export class ProgramWorkflowDraftDto {
  @ApiProperty({ format: 'uuid' }) @IsUUID() institutionId!: string;
  @ApiProperty() @IsObject() definition!: Record<string, unknown>;
  @ApiProperty() @IsString() @Matches(positive) maxExposureMinor!: string;
  @ApiProperty() @IsString() @Matches(currency) currency!: string;
  @ApiProperty() @IsISO8601() deadline!: string;
  @ApiProperty() @IsString() @Matches(keyText) idempotencyKey!: string;
  @ApiProperty() @IsInt() @Min(1) @Max(5) requiredApprovals!: number;
}
export class ProgramWorkflowIdDto {
  @ApiProperty({ format: 'uuid' }) @IsUUID() workflowId!: string;
}
export class ProgramWorkflowExecuteDto {
  @ApiProperty({ format: 'uuid' }) @IsUUID() workflowId!: string;
  @ApiProperty() @IsString() @Matches(keyText) idempotencyKey!: string;
}
export class ProgramSettleDto {
  @ApiProperty({ format: 'uuid' }) @IsUUID() institutionId!: string;
  @ApiProperty() @IsString() @Matches(keyText) idempotencyKey!: string;
  @ApiProperty() @IsISO8601() deadline!: string;
  @ApiProperty({ type: 'array' }) @IsArray() legs!: unknown[];
}
export class ProgramCoordinateDto {
  @ApiProperty({ format: 'uuid' }) @IsUUID() institutionId!: string;
  @ApiProperty() @IsString() @Matches(keyText) idempotencyKey!: string;
  @ApiProperty({ type: 'array' }) @IsArray() legs!: unknown[];
}
export class ProgramEscrowFundDto {
  @ApiProperty({ format: 'uuid' }) @IsUUID() institutionId!: string;
  @ApiProperty({ format: 'uuid' }) @IsUUID() sourceAccountId!: string;
  @ApiProperty() @IsString() @Matches(positive) amountMinor!: string;
  @ApiProperty({ format: 'uuid' }) @IsUUID() beneficiaryInstitutionId!: string;
  @ApiProperty() @IsString() @MinLength(1) @MaxLength(80) beneficiaryRef!: string;
  @ApiProperty() @IsObject() conditions!: Record<string, unknown>;
  @ApiProperty() @IsISO8601() expiresAt!: string;
  @ApiProperty() @IsString() @Matches(keyText) idempotencyKey!: string;
}
export class ProgramEscrowReleaseDto {
  @ApiProperty({ format: 'uuid' }) @IsUUID() escrowId!: string;
  @ApiProperty({ format: 'uuid' }) @IsUUID() toAccountId!: string;
}
export class ProgramEscrowKeyDto {
  @ApiProperty({ format: 'uuid' }) @IsUUID() escrowId!: string;
  @ApiProperty() @IsString() @Matches(keyText) idempotencyKey!: string;
}
export class ProgramEscrowIdDto {
  @ApiProperty({ format: 'uuid' }) @IsUUID() escrowId!: string;
}
export class ProgramTreasuryRecommendDto {
  @ApiProperty({ format: 'uuid' }) @IsUUID() institutionId!: string;
  @ApiProperty() @IsString() @Matches(movement) movement!: string;
  @ApiProperty() @IsString() @Matches(amount) amountMinor!: string;
  @ApiProperty() @IsString() @Matches(currency) currency!: string;
  @ApiPropertyOptional() @IsOptional() @IsString() @Matches(accountKind) fromKind?: string;
  @ApiPropertyOptional() @IsOptional() @IsString() @Matches(accountKind) toKind?: string;
}
export class ProgramTreasuryIdDto {
  @ApiProperty({ format: 'uuid' }) @IsUUID() treasuryId!: string;
}
export class ProgramTreasuryExecuteDto {
  @ApiProperty({ format: 'uuid' }) @IsUUID() treasuryId!: string;
  @ApiProperty() @IsString() @Matches(keyText) idempotencyKey!: string;
}
export class ProgramAssetRegisterDto {
  @ApiProperty({ format: 'uuid' }) @IsUUID() institutionId!: string;
  @ApiProperty() @IsString() @Matches(assetType) assetType!: string;
  @ApiProperty() @IsString() @Matches(codeText) code!: string;
  @ApiProperty() @IsString() @Matches(currency) denomination!: string;
}
export class ProgramAssetIdDto {
  @ApiProperty({ format: 'uuid' }) @IsUUID() assetId!: string;
}
export class ProgramAssetIssueDto {
  @ApiProperty({ format: 'uuid' }) @IsUUID() institutionId!: string;
  @ApiProperty({ format: 'uuid' }) @IsUUID() assetId!: string;
  @ApiProperty() @IsString() @Matches(positive) quantityMinor!: string;
  @ApiProperty() @IsString() @Matches(keyText) idempotencyKey!: string;
}
export class ProgramAssetTransferDto {
  @ApiProperty({ format: 'uuid' }) @IsUUID() fromInstitutionId!: string;
  @ApiProperty({ format: 'uuid' }) @IsUUID() assetId!: string;
  @ApiProperty({ format: 'uuid' }) @IsUUID() toInstitutionId!: string;
  @ApiProperty() @IsString() @Matches(positive) quantityMinor!: string;
  @ApiProperty() @IsString() @Matches(keyText) idempotencyKey!: string;
}
export class ProgramQuoteOpenDto {
  @ApiProperty({ format: 'uuid' }) @IsUUID() institutionId!: string;
  @ApiProperty({ format: 'uuid' }) @IsUUID() baseAssetId!: string;
  @ApiProperty({ format: 'uuid' }) @IsUUID() quoteAssetId!: string;
  @ApiProperty() @IsString() @Matches(positive) unitPriceMinor!: string;
  @ApiProperty() @IsString() @Matches(positive) quantityMinor!: string;
  @ApiProperty() @IsString() @Matches(quoteKind) kind!: string;
  @ApiProperty() @IsISO8601() expiresAt!: string;
}
export class ProgramQuoteExecuteDto {
  @ApiProperty({ format: 'uuid' }) @IsUUID() buyerInstitutionId!: string;
  @ApiProperty({ format: 'uuid' }) @IsUUID() quoteId!: string;
  @ApiProperty() @IsString() @Matches(positive) unitPriceMinor!: string;
  @ApiProperty() @IsString() @Matches(keyText) idempotencyKey!: string;
}
export class ProgramCollateralPledgeDto {
  @ApiProperty({ format: 'uuid' }) @IsUUID() institutionId!: string;
  @ApiProperty({ format: 'uuid' }) @IsUUID() assetId!: string;
  @ApiProperty() @IsString() @Matches(positive) quantityMinor!: string;
  @ApiProperty() @IsInt() @Min(0) @Max(9999) haircutBps!: number;
  @ApiProperty() @IsString() @MinLength(3) @MaxLength(40) arrangementKey!: string;
}
export class ProgramCollateralIdDto {
  @ApiProperty({ format: 'uuid' }) @IsUUID() collateralId!: string;
}
export class ProgramFusdRequestDto {
  @ApiProperty({ format: 'uuid' }) @IsUUID() institutionId!: string;
  @ApiProperty({ format: 'uuid' }) @IsUUID() bookId!: string;
  @ApiProperty() @IsString() @Matches(positive) amountMinor!: string;
  @ApiProperty() @IsString() @Matches(keyText) idempotencyKey!: string;
  @ApiPropertyOptional() @IsOptional() @IsISO8601() notBefore?: string;
}
export class ProgramSuspendDto {
  @ApiProperty({ format: 'uuid' }) @IsUUID() institutionId!: string;
  @ApiProperty() @IsBoolean() suspend!: boolean;
}
