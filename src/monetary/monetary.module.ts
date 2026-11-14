import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module';
import { DatabaseModule } from '../database/database.module';
import { MonetaryController } from './monetary.controller';
import { MonetaryService } from './monetary.service';

@Module({ imports: [AuthModule, DatabaseModule], controllers: [MonetaryController], providers: [MonetaryService] })
export class MonetaryModule {}
