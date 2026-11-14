import { ApiProperty } from '@nestjs/swagger';
import { ArrayMaxSize, ArrayNotEmpty, IsArray, IsIn, IsInt, IsISO8601, IsObject, IsString, IsUUID, Matches, Max, MaxLength, Min, MinLength } from 'class-validator';

const amount = /^(0|[1-9][0-9]{0,18})$/;
const positive = /^[1-9][0-9]{0,18}$/;
const label = /^[a-z0-9.-]{3,40}$/;
const hexKey = /^[0-9a-f]{64}$/;
const hexSig = /^[0-9a-f]{128}$/;
const text80 = /^[^|]{1,80}$/;
const keyText = /^[^|]{8,80}$/;
const families = ['pain.001.001.09', 'pacs.008.001.08', 'pacs.002.001.10', 'pacs.004.001.09', 'camt.053.001.08'] as const;
const memberStates = ['UNDER_REVIEW', 'APPROVED_FOR_SIMULATION', 'ACTIVE_SIMULATION', 'SUSPENDED', 'TERMINATED'] as const;
const scenarios = [
  'MEMBER_FAILS_TO_SETTLE', 'LIQUIDITY_LOSS', 'OUTGOING_SURGE', 'DEBIT_LIMIT_EXCEEDED', 'PROVIDER_OUTAGE',
  'SUSPENDED_DURING_CLEARING', 'DELAYED_CONFIRMATION', 'DUPLICATE_MESSAGE', 'UNEXPECTED_RETURN', 'CORRUPTED_EVIDENCE',
] as const;

export class NetworkApplyDto {
  @ApiProperty({ format: 'uuid' }) @IsUUID() institutionId!: string;
}
export class NetworkTransitionDto {
  @ApiProperty({ format: 'uuid' }) @IsUUID() institutionId!: string;
  @ApiProperty({ enum: memberStates }) @IsIn(memberStates) toStatus!: string;
}
export class NetworkRulebookDto {
  @ApiProperty() @IsString() @Matches(label) versionLabel!: string;
  @ApiProperty() @IsObject() body!: Record<string, unknown>;
}
export class NetworkRulebookIdDto {
  @ApiProperty({ format: 'uuid' }) @IsUUID() rulebookId!: string;
}
export class NetworkAcceptDto {
  @ApiProperty({ format: 'uuid' }) @IsUUID() institutionId!: string;
  @ApiProperty({ format: 'uuid' }) @IsUUID() rulebookId!: string;
}
export class NetworkCurrenciesDto {
  @ApiProperty({ format: 'uuid' }) @IsUUID() institutionId!: string;
  @ApiProperty({ type: [String] }) @IsArray() @ArrayNotEmpty() @ArrayMaxSize(8) @IsString({ each: true }) @Matches(/^[A-Z]{3}$/, { each: true }) currencies!: string[];
}
export class NetworkCertificateDto {
  @ApiProperty({ format: 'uuid' }) @IsUUID() institutionId!: string;
  @ApiProperty() @IsString() @Matches(hexKey) publicKeyHex!: string;
  @ApiProperty() @IsISO8601() notBefore!: string;
  @ApiProperty() @IsISO8601() notAfter!: string;
}
export class NetworkCertificateRevokeDto {
  @ApiProperty({ format: 'uuid' }) @IsUUID() institutionId!: string;
  @ApiProperty({ format: 'uuid' }) @IsUUID() certificateId!: string;
}
export class NetworkLiquidityDto {
  @ApiProperty({ format: 'uuid' }) @IsUUID() institutionId!: string;
  @ApiProperty() @IsString() @Matches(amount) openingMinor!: string;
  @ApiProperty() @IsString() @Matches(amount) capacityMinor!: string;
  @ApiProperty() @IsString() @Matches(amount) netDebitLimitMinor!: string;
}
export class NetworkPaymentDto {
  @ApiProperty({ format: 'uuid' }) @IsUUID() originInstitutionId!: string;
  @ApiProperty({ format: 'uuid' }) @IsUUID() beneficiaryInstitutionId!: string;
  @ApiProperty({ format: 'uuid' }) @IsUUID() originAccountId!: string;
  @ApiProperty({ format: 'uuid' }) @IsUUID() beneficiaryAccountId!: string;
  @ApiProperty() @IsString() @Matches(/^[A-Z]{3}$/) currency!: string;
  @ApiProperty() @IsString() @Matches(positive) amountMinor!: string;
  @ApiProperty() @IsString() @Matches(text80) purpose!: string;
  @ApiProperty() @IsString() @Matches(keyText) idempotencyKey!: string;
  @ApiProperty({ format: 'uuid' }) @IsUUID() certificateId!: string;
  @ApiProperty() @IsString() @Matches(hexSig) signatureHex!: string;
  @ApiProperty() @IsString() @MinLength(8) @MaxLength(80) nonce!: string;
  @ApiProperty() @IsInt() @Min(60) @Max(604800) ttlSeconds!: number;
}
export class NetworkPaymentIdDto {
  @ApiProperty({ format: 'uuid' }) @IsUUID() paymentId!: string;
}
export class NetworkCycleDto {
  @ApiProperty({ enum: ['BILATERAL', 'MULTILATERAL'] }) @IsIn(['BILATERAL', 'MULTILATERAL']) kind!: string;
  @ApiProperty() @IsString() @Matches(/^[A-Z]{3}$/) currency!: string;
  @ApiProperty({ type: [String] }) @IsArray() @ArrayNotEmpty() @IsUUID('4', { each: true }) memberIds!: string[];
}
export class NetworkCycleIdDto {
  @ApiProperty({ format: 'uuid' }) @IsUUID() cycleId!: string;
}
export class NetworkConfirmDto {
  @ApiProperty({ format: 'uuid' }) @IsUUID() cycleId!: string;
  @ApiProperty() @IsString() @Matches(hexSig) signature!: string;
}
export class NetworkMessageDto {
  @ApiProperty({ format: 'uuid' }) @IsUUID() paymentId!: string;
  @ApiProperty({ enum: families }) @IsIn(families) family!: string;
  @ApiProperty() @IsString() @MinLength(8) @MaxLength(80) messageId!: string;
  @ApiProperty() @IsString() @MinLength(1) @MaxLength(8000) body!: string;
}
export class NetworkStressDto {
  @ApiProperty({ format: 'uuid' }) @IsUUID() institutionId!: string;
  @ApiProperty({ enum: scenarios }) @IsIn(scenarios) scenario!: string;
}
