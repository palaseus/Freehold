import { Module } from '@nestjs/common';
import { DatabaseService } from './database.service';
import { RestrictedFunctions } from './restricted-functions.service';
// The authentication database credential is not constructed in this process.
@Module({ providers: [DatabaseService, RestrictedFunctions], exports: [DatabaseService, RestrictedFunctions] })
export class DatabaseModule {}
