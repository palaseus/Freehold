import { ApiProperty } from '@nestjs/swagger';
import { IsString, Matches } from 'class-validator';
export class CreateAccountDto {
  @ApiProperty({ example: 'USD', pattern: '^[A-Z][A-Z0-9]{2,11}$' })
  @IsString() @Matches(/^[A-Z][A-Z0-9]{2,11}$/) currency!: string;
}
export class BalanceResponse {
  @ApiProperty({ format: 'uuid' }) id!: string;
  @ApiProperty({ example: 'USD' }) currency!: string;
  @ApiProperty({ enum: ['ACTIVE', 'FROZEN', 'CLOSED'] }) status!: string;
  @ApiProperty({ type: String, example: '2500' }) availableMinor!: string;
  @ApiProperty({ type: String, example: '0' }) reservedMinor!: string;
  @ApiProperty({ type: String, example: '2500' }) totalMinor!: string;
}
