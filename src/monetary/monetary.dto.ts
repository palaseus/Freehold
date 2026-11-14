import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { IsBoolean, IsIn, IsInt, IsOptional, IsString, IsUUID, Matches, MaxLength, Min } from 'class-validator';

const amount = /^(0|[1-9][0-9]{0,18})$/;
const positive = /^[1-9][0-9]{0,18}$/;
const day = /^\d{4}-\d{2}-\d{2}$/;

export class BankOpenDto {
  @ApiProperty({ format: 'uuid' }) @IsUUID() accountId!: string;
}
export class BankEventDto {
  @ApiProperty({ format: 'uuid' }) @IsUUID() bankAccountId!: string;
  @ApiProperty({ enum: ['ACCOUNT_OPEN', 'DEPOSIT', 'WITHDRAWAL', 'RETURN'] })
  @IsIn(['ACCOUNT_OPEN', 'DEPOSIT', 'WITHDRAWAL', 'RETURN']) kind!: string;
  @ApiProperty() @IsString() @MaxLength(200) externalId!: string;
  @ApiProperty() @IsString() @Matches(amount) amountMinor!: string;
  @ApiProperty({ enum: ['CREATED', 'PENDING', 'SUBMITTED', 'ACKNOWLEDGED', 'SETTLED', 'FAILED', 'RETURNED', 'UNKNOWN'] })
  @IsIn(['CREATED', 'PENDING', 'SUBMITTED', 'ACKNOWLEDGED', 'SETTLED', 'FAILED', 'RETURNED', 'UNKNOWN']) state!: string;
  @ApiPropertyOptional() @IsOptional() @IsString() @MaxLength(200) signature?: string;
}
export class ConversionDto {
  @ApiProperty({ format: 'uuid' }) @IsUUID() accountId!: string;
  @ApiProperty() @IsString() @Matches(positive) amountMinor!: string;
}
export class IssueRequestDto {
  @ApiProperty({ format: 'uuid' }) @IsUUID() bookId!: string;
  @ApiProperty() @IsString() @Matches(positive) amountMinor!: string;
  @ApiPropertyOptional({ format: 'uuid' }) @IsOptional() @IsUUID() holderId?: string;
}
export class RedeemRequestDto {
  @ApiProperty({ format: 'uuid' }) @IsUUID() bookId!: string;
  @ApiProperty() @IsString() @Matches(positive) amountMinor!: string;
}
export class SettlementDto {
  @ApiProperty({ enum: ['SETTLEMENT_CONFIRMED', 'FAILED', 'EXCEPTION'] })
  @IsIn(['SETTLEMENT_CONFIRMED', 'FAILED', 'EXCEPTION']) outcome!: string;
}
export class ReserveProposeDto {
  @ApiProperty({ format: 'uuid' }) @IsUUID() bookId!: string;
  @ApiProperty() @IsString() @MaxLength(80) category!: string;
  @ApiProperty() @IsString() @Matches(positive) amountMinor!: string;
  @ApiProperty() @IsString() @MaxLength(200) assetRef!: string;
  @ApiPropertyOptional() @IsOptional() @IsString() @Matches(day) maturityDate?: string;
}
export class ReserveReviewDto {
  @ApiProperty({ enum: ['VERIFIED', 'REJECTED'] }) @IsIn(['VERIFIED', 'REJECTED']) decision!: string;
}
export class EncumberDto {
  @ApiProperty() @IsBoolean() encumbered!: boolean;
}
export class GrantDto {
  @ApiProperty({ format: 'uuid' }) @IsUUID() principalId!: string;
  @ApiProperty() @IsString() @MaxLength(80) capability!: string;
}
export class SuspendDto {
  @ApiProperty() @IsBoolean() suspended!: boolean;
}
export class CapRequestDto {
  @ApiProperty({ format: 'uuid' }) @IsUUID() bookId!: string;
  @ApiProperty() @IsString() @Matches(amount) proposedMax!: string;
}
export class ReportDraftDto {
  @ApiProperty({ format: 'uuid' }) @IsUUID() bookId!: string;
  @ApiProperty() @IsString() @Matches(day) periodStart!: string;
  @ApiProperty() @IsString() @Matches(day) periodEnd!: string;
}
export class ReportTransitionDto {
  @ApiProperty() @IsString() @MaxLength(80) state!: string;
}
export class MonetaryActivateDto {
  @ApiProperty() @IsString() @MaxLength(200) reason!: string;
}
export class ChainObserveDto {
  @ApiProperty({ format: 'uuid' }) @IsUUID() bookId!: string;
  @ApiProperty({ enum: ['ISSUE', 'BURN', 'TRANSFER'] }) @IsIn(['ISSUE', 'BURN', 'TRANSFER']) kind!: string;
  @ApiProperty() @IsString() @MaxLength(200) txRef!: string;
  @ApiProperty({ enum: ['NOT_FINAL', 'FINAL', 'REORGED', 'INTERRUPTED', 'REPLACED'] })
  @IsIn(['NOT_FINAL', 'FINAL', 'REORGED', 'INTERRUPTED', 'REPLACED']) finality!: string;
  @ApiProperty() @IsInt() @Min(0) confirmationDepth!: number;
  @ApiProperty() @IsString() @Matches(amount) observedAmount!: string;
}
export class ReorgDto {
  @ApiProperty() @IsString() @MaxLength(200) txRef!: string;
}
export class FhuIssueDto {
  @ApiProperty() @IsString() @Matches(positive) amountMinor!: string;
  @ApiPropertyOptional({ format: 'uuid' }) @IsOptional() @IsUUID() holderId?: string;
}
export class ScreenDto {
  @ApiProperty() @IsString() @MaxLength(200) subjectRef!: string;
}
export class RestrictionDto {
  @ApiProperty({ format: 'uuid' }) @IsUUID() subjectUserId!: string;
  @ApiProperty({ enum: ['REVIEW', 'BLOCK_SIMULATED_ISSUANCE', 'BLOCK_SIMULATED_REDEMPTION'] })
  @IsIn(['REVIEW', 'BLOCK_SIMULATED_ISSUANCE', 'BLOCK_SIMULATED_REDEMPTION']) kind!: string;
  @ApiProperty() @IsString() @MaxLength(500) reason!: string;
}
export class FreezeDto {
  @ApiProperty({ format: 'uuid' }) @IsUUID() bookId!: string;
  @ApiProperty({ format: 'uuid' }) @IsUUID() holderId!: string;
  @ApiProperty() @IsString() @Matches(positive) amountMinor!: string;
  @ApiProperty() @IsBoolean() freeze!: boolean;
}
export class CapitalDto {
  @ApiProperty() @IsString() @Matches(amount) amountMinor!: string;
}
export class DisclosureAckDto {
  @ApiProperty({ enum: ['USD_BANK_DEPOSIT', 'PAYMENT_STABLECOIN'] })
  @IsIn(['USD_BANK_DEPOSIT', 'PAYMENT_STABLECOIN']) product!: string;
  @ApiProperty() @IsString() @MaxLength(40) version!: string;
}
export class EvidenceOpenDto {
  @ApiProperty() @IsString() @MaxLength(80) controlId!: string;
  @ApiProperty() @IsString() @MaxLength(300) citation!: string;
  @ApiProperty() @IsString() @MaxLength(300) sourceTitle!: string;
  @ApiProperty() @IsString() @MaxLength(500) technicalControl!: string;
  @ApiProperty() @IsString() @MaxLength(200) testRef!: string;
  @ApiProperty() @IsString() @MaxLength(80) responsibleRole!: string;
  @ApiPropertyOptional() @IsOptional() @IsString() @MaxLength(500) deficiency?: string;
  @ApiPropertyOptional() @IsOptional() @IsString() @Matches(day) expiresOn?: string;
}
export class EvidenceNoteDto {
  @ApiProperty() @IsString() @MaxLength(500) note!: string;
}
export class PartnerOpenDto {
  @ApiProperty() @IsString() @MaxLength(160) legalName!: string;
  @ApiProperty({ enum: ['PROSPECTIVE_BANK', 'PROSPECTIVE_CUSTODIAN', 'PROSPECTIVE_ISSUER'] })
  @IsIn(['PROSPECTIVE_BANK', 'PROSPECTIVE_CUSTODIAN', 'PROSPECTIVE_ISSUER']) entityKind!: string;
}
export class PartnerCheckDto {
  @ApiProperty({ enum: ['IDENTITY', 'LICENSE_OR_CHARTER', 'SERVICE_AGREEMENT', 'DUE_DILIGENCE', 'PRODUCTS', 'SETTLEMENT', 'CUSTODY', 'CONTACTS', 'COMPLIANCE', 'EXPIRATION', 'ESCALATION', 'INTEGRATION'] })
  @IsIn(['IDENTITY', 'LICENSE_OR_CHARTER', 'SERVICE_AGREEMENT', 'DUE_DILIGENCE', 'PRODUCTS', 'SETTLEMENT', 'CUSTODY', 'CONTACTS', 'COMPLIANCE', 'EXPIRATION', 'ESCALATION', 'INTEGRATION']) item!: string;
}
