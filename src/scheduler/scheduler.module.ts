import { Module } from '@nestjs/common';
import { ScheduleRunner } from './schedule.runner';
import { SchedulerDatabaseService } from './scheduler-database.service';
@Module({ providers: [SchedulerDatabaseService, ScheduleRunner] })
export class SchedulerModule {}
