import { ApiPropertyOptional } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import { IsInt, IsOptional, IsString, Max, MaxLength, Min } from 'class-validator';
export class AdminQueryDto {
  @ApiPropertyOptional() @IsOptional() @IsString() @MaxLength(320) query = '';
  @ApiPropertyOptional({ default: 30 }) @Type(() => Number) @IsInt() @Min(1) @Max(100) limit = 30;
}
