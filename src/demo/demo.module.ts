import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module';
import { DatabaseModule } from '../database/database.module';
import { DemoController } from './demo.controller';
import { DemoBootstrapGuard, DemoGuard } from './demo.guards';
@Module({ imports: [AuthModule, DatabaseModule], controllers: [DemoController], providers: [DemoBootstrapGuard, DemoGuard] })
export class DemoModule {}
