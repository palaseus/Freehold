import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module';
import { DatabaseModule } from '../database/database.module';
import { AdminController, AdminObservabilityController } from './admin.controller';
import { AdminService } from './admin.service';
import { OperationsController } from './operations.controller';
import { OperationsService } from './operations.service';
@Module({ imports: [AuthModule, DatabaseModule], controllers: [AdminController, AdminObservabilityController, OperationsController], providers: [AdminService, OperationsService] })
export class AdminModule {}
