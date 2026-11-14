import { ApiProperty } from '@nestjs/swagger';
import { IsString, Length, Matches } from 'class-validator';
export class DemoFundDto {
  @ApiProperty({ type: String, example: '250000' })
  @IsString() @Matches(/^[1-9][0-9]{0,18}$/) amountMinor!: string;
  @ApiProperty() @IsString() @Length(1, 1000) @Matches(/\S/) reason!: string;
}
