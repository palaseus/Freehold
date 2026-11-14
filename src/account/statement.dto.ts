import { Type } from 'class-transformer';
import { IsInt, IsISO8601, IsOptional, IsString, Max, MaxLength, Min } from 'class-validator';
export class StatementQueryDto {
  @IsISO8601() from!: string;
  @IsISO8601() to!: string;
  @IsOptional() @Type(() => Number) @IsInt() @Min(1) @Max(500) limit?: number;
  @IsOptional() @IsString() @MaxLength(1024) cursor?: string;
}
