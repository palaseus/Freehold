import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module';
import { DatabaseModule } from '../database/database.module';
import { HistoryService } from './history.service';
import { CurrencyController } from './currency.controller';
import { AccountController } from './account.controller';
import { AccountService } from './account.service';
import { AccountOwnershipGuard } from './ownership.guard';
import { StatementService } from './statement.service';
import { ControlsService } from './controls.service';
@Module({ imports: [AuthModule, DatabaseModule], controllers: [AccountController, CurrencyController],
  providers: [HistoryService, AccountService, AccountOwnershipGuard, StatementService, ControlsService], exports: [AccountService, AccountOwnershipGuard] })
export class AccountModule {}
