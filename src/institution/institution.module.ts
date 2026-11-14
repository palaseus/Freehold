import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module';
import { DatabaseModule } from '../database/database.module';
import { InstitutionController } from './institution.controller';
import { InstitutionSandboxController } from './institution.sandbox.controller';
import { InstitutionService } from './institution.service';
import { NetworkController } from './network.controller';
import { NetworkService } from './network.service';
import { ProgramController } from './program.controller';
import { ProgramService } from './program.service';

@Module({
  imports: [AuthModule, DatabaseModule],
  controllers: [InstitutionController, InstitutionSandboxController, NetworkController, ProgramController],
  providers: [InstitutionService, NetworkService, ProgramService],
})
export class InstitutionModule {}
