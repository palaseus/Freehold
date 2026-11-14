import { BadRequestException, createParamDecorator, ExecutionContext, applyDecorators } from '@nestjs/common';
import { ApiBadRequestResponse, ApiConflictResponse, ApiCookieAuth, ApiForbiddenResponse, ApiHeader, ApiOkResponse, ApiProperty, ApiPropertyOptional, ApiResponse, ApiServiceUnavailableResponse, ApiUnauthorizedResponse } from '@nestjs/swagger';
import type { FastifyRequest } from 'fastify';
import type { Principal } from '../auth/auth.types';
export const CurrentPrincipal = createParamDecorator((_data: unknown, ctx: ExecutionContext): Principal => ctx.switchToHttp().getRequest<FastifyRequest>().principal!);
export const IdempotencyKey = createParamDecorator((_data: unknown, ctx: ExecutionContext): string => {
  const key = ctx.switchToHttp().getRequest<FastifyRequest>().headers['idempotency-key'];
  if (typeof key !== 'string' || !/^[\x21-\x7e]{1,200}$/.test(key)) throw new BadRequestException('A 1–200 character Idempotency-Key header is required');
  return key;
});
export class OperationResponse {
  @ApiProperty({ format: 'uuid' }) operationId!: string;
  @ApiProperty({ format: 'uuid' }) correlationId!: string;
  @ApiProperty({ enum: ['COMPLETED', 'REJECTED'] }) state!: string;
  @ApiPropertyOptional() error?: string;
  @ApiPropertyOptional({ format: 'uuid' }) transferId?: string;
  @ApiPropertyOptional({ format: 'uuid' }) accountId?: string;
  @ApiPropertyOptional({ format: 'uuid' }) journalId?: string;
  @ApiPropertyOptional({ type: String, example: '2500' }) amountMinor?: string;
  @ApiPropertyOptional({ example: 'USD' }) currency?: string;
  @ApiPropertyOptional() frozen?: boolean;
}
export function FinancialApi() {
  return applyDecorators(
    ApiCookieAuth('session'), ApiHeader({ name: 'X-CSRF-Token', required: true }),
    ApiHeader({ name: 'Idempotency-Key', required: true, schema: { type: 'string', minLength: 1, maxLength: 200 } }),
    ApiOkResponse({ type: OperationResponse, description: 'Committed durable result, including original result on replay.' }),
    ApiResponse({ status: 422, type: OperationResponse, description: 'Committed business rejection. Reusing the key returns this rejection.' }),
    ApiConflictResponse({ description: 'IDEMPOTENCY_CONFLICT: key reused with different payload.' }),
    ApiBadRequestResponse({ description: 'Invalid payload or database input.' }),
    ApiUnauthorizedResponse(), ApiForbiddenResponse(),
    ApiServiceUnavailableResponse({ description: 'Outcome may be unknown. Retry the same payload and key.' }),
  );
}
