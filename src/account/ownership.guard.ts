import { BadRequestException, CanActivate, ExecutionContext, Injectable, SetMetadata } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { isUUID } from 'class-validator';
import type { FastifyRequest } from 'fastify';
import { AccountService } from './account.service';
export const OwnAccount = (location: 'body' | 'params', field: string) => SetMetadata('owned-account', { location, field });
@Injectable()
export class AccountOwnershipGuard implements CanActivate {
  constructor(private readonly reflector: Reflector, private readonly accounts: AccountService) {}
  async canActivate(context: ExecutionContext) {
    const spec = this.reflector.get<{ location: 'body' | 'params'; field: string }>('owned-account', context.getHandler());
    const req = context.switchToHttp().getRequest<FastifyRequest>();
    const container = req[spec.location] as Record<string, unknown> | undefined;
    const account = container?.[spec.field];
    // Guards run before DTO pipes. Validate UUID before submitting it to pg.
    if (typeof account !== 'string' || !isUUID(account)) throw new BadRequestException('Invalid account ID');
    await this.accounts.assertOwned(account, req.principal!);
    return true;
  }
}
