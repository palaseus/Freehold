import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { IsBoolean, IsIn, IsInt, IsISO8601, IsOptional, IsString, IsUUID, Matches, Max, Min, ValidateIf } from 'class-validator';

export class ScheduleCreateDto {
  @ApiProperty({ format: 'uuid' }) @IsUUID() sourceAccountId!: string;
  @ApiProperty({ format: 'uuid' }) @IsUUID() destinationAccountId!: string;
  @ApiProperty() @IsString() @Matches(/^[A-Z][A-Z0-9]{2,11}$/) currency!: string;
  @ApiProperty() @IsString() @Matches(/^[1-9][0-9]{0,18}$/) amountMinor!: string;
  @ApiProperty({ enum: ['ONCE', 'DAILY', 'WEEKLY', 'MONTHLY'] }) @IsIn(['ONCE', 'DAILY', 'WEEKLY', 'MONTHLY']) cadence!: 'ONCE' | 'DAILY' | 'WEEKLY' | 'MONTHLY';
  @ApiProperty({ description: 'UTC timestamp. Monthly steps use UTC calendar months.' }) @IsISO8601() nextExecutionAt!: string;
}
export class TrustDestinationDto {
  @ApiProperty({ format: 'uuid' }) @IsUUID() destinationAccountId!: string;
}
export class AccountControlPatchDto {
  @ApiPropertyOptional() @IsOptional() @IsBoolean() outgoingEnabled?: boolean;
  @ApiPropertyOptional() @IsOptional() @ValidateIf((_, value) => value !== null && value !== '') @IsString() @Matches(/^[1-9][0-9]{0,18}$/) perTransferLimitMinor?: string | null;
  @ApiPropertyOptional() @IsOptional() @ValidateIf((_, value) => value !== null && value !== '') @IsString() @Matches(/^[1-9][0-9]{0,18}$/) dailyLimitMinor?: string | null;
  @ApiPropertyOptional() @IsOptional() @ValidateIf((_, value) => value !== null && value !== '') @IsString() @Matches(/^[1-9][0-9]{0,18}$/) monthlyLimitMinor?: string | null;
  @ApiPropertyOptional() @IsOptional() @ValidateIf((_, value) => value !== null) @IsInt() @Min(0) @Max(31622400) newDestinationReviewSeconds?: number | null;
  @ApiPropertyOptional() @IsOptional() @ValidateIf((_, value) => value !== null && value !== '') @IsString() @Matches(/^[1-9][0-9]{0,18}$/) stepUpThresholdMinor?: string | null;
}
