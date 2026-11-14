import { Module } from '@nestjs/common';
import { ConfigModule } from './config/config.module';
import { DatabaseModule } from './database/database.module';
import { AuthModule } from './auth/auth.module';
import { AccountModule } from './account/account.module';
import { TransferModule } from './transfer/transfer.module';
import { DemoModule } from './demo/demo.module';
import { AdminModule } from './admin/admin.module';
import { ScheduleModule } from './schedule/schedule.module';
import { MonetaryModule } from './monetary/monetary.module';
import { InstitutionModule } from './institution/institution.module';
@Module({ imports: [ConfigModule, DatabaseModule, AuthModule, AccountModule, TransferModule, AdminModule, DemoModule, ScheduleModule, MonetaryModule, InstitutionModule] })
export class AppModule {}
