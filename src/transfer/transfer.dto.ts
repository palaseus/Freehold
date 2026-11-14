import { ApiProperty } from '@nestjs/swagger';
import { IsString, IsUUID, Matches } from 'class-validator';
export class CustomerTransferDto {
  @ApiProperty({ format: 'uuid' }) @IsUUID() sourceAccountId!: string;
  @ApiProperty({ format: 'uuid' }) @IsUUID() destinationAccountId!: string;
  @ApiProperty({ example: 'USD', pattern: '^[A-Z][A-Z0-9]{2,11}$' })
  @IsString() @Matches(/^[A-Z][A-Z0-9]{2,11}$/) currency!: string;
  @ApiProperty({ type: String, example: '2500', pattern: '^[1-9][0-9]{0,18}$', description: 'Positive integer string. PostgreSQL enforces operation and balance limits.' })
  @IsString() @Matches(/^[1-9][0-9]{0,18}$/) amountMinor!: string;
}
