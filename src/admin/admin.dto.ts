import { ApiProperty } from '@nestjs/swagger';
import { IsString, Length, Matches } from 'class-validator';
export class AdminReasonDto {
  @ApiProperty({ minLength: 1, maxLength: 1000, example: 'Account access investigation' })
  @IsString() @Length(1, 1000) @Matches(/\S/) reason!: string;
}
