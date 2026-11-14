import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Transform } from 'class-transformer';
import { IsEmail, IsOptional, IsString, Length, Matches } from 'class-validator';
export class LoginDto {
  @ApiProperty({ example: 'alice@example.test' })
  @Transform(({ value }: { value: unknown }) => typeof value === 'string' ? value.trim().toLowerCase() : value)
  @IsEmail() @Length(3, 320) email!: string;
  @ApiProperty({ minLength: 1, maxLength: 128, writeOnly: true })
  @IsString() @Length(1, 128) password!: string;
  @ApiPropertyOptional({ pattern: '^\\d{6}$', description: 'Required when TOTP is enrolled; login establishes recent 2FA.' })
  @IsOptional() @IsString() @Matches(/^\d{6}$/) totp?: string;
}
export class RegisterDto extends LoginDto {
  @ApiPropertyOptional({ description: 'Optional base32 TOTP secret; requires a matching initial totp code.', minLength: 32, maxLength: 64 })
  @IsOptional() @IsString() @Matches(/^[A-Z2-7]{32,64}$/) totpSecret?: string;
}
