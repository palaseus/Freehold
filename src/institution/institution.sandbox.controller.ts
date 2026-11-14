import { Body, Controller, Get, Headers, HttpCode, Param, ParseUUIDPipe, Post } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import { InstitutionTransferDto, InvoiceDto, PaymentOpenDto, PaymentTransitionDto } from './institution.dto';
import { InstitutionService } from './institution.service';

@ApiTags('institution-sandbox')
@Controller('institution/sandbox')
export class InstitutionSandboxController {
  constructor(private readonly institution: InstitutionService) {}

  private cred(authorization?: string, nonce?: string, institutionId?: string) {
    return this.institution.credential(authorization, nonce, institutionId);
  }

  @Get('accounts/:accountId')
  account(
    @Param('accountId', ParseUUIDPipe) accountId: string,
    @Headers('authorization') authorization?: string,
    @Headers('x-institution-nonce') nonce?: string,
    @Headers('x-institution-id') institutionId?: string,
    @Headers('x-correlation-id') correlation?: string,
  ) {
    const cred = this.cred(authorization, nonce, institutionId);
    return this.institution.sandboxAccount(cred.keyId, cred.secret, cred.nonce, cred.institutionId, accountId, this.institution.correlation(correlation));
  }

  @Get('treasury')
  treasury(
    @Headers('authorization') authorization?: string,
    @Headers('x-institution-nonce') nonce?: string,
    @Headers('x-institution-id') institutionId?: string,
    @Headers('x-correlation-id') correlation?: string,
  ) {
    const cred = this.cred(authorization, nonce, institutionId);
    return this.institution.sandboxTreasury(cred.keyId, cred.secret, cred.nonce, cred.institutionId, this.institution.correlation(correlation));
  }

  @Post('transfers') @HttpCode(200)
  transfer(@Body() dto: InstitutionTransferDto, @Headers('authorization') authorization?: string, @Headers('x-institution-nonce') nonce?: string, @Headers('x-correlation-id') correlation?: string) {
    const cred = this.cred(authorization, nonce, dto.institutionId);
    return this.institution.sandboxTransfer(cred.keyId, cred.secret, cred.nonce, cred.institutionId, dto.fromAccountId, dto.toAccountId, dto.amountMinor, dto.idempotencyKey, dto.correlationId ?? this.institution.correlation(correlation));
  }

  @Post('payments') @HttpCode(200)
  payment(@Body() dto: PaymentOpenDto, @Headers('authorization') authorization?: string, @Headers('x-institution-nonce') nonce?: string, @Headers('x-correlation-id') correlation?: string) {
    const cred = this.cred(authorization, nonce, dto.institutionId);
    return this.institution.sandboxPayment(cred.keyId, cred.secret, cred.nonce, cred.institutionId, dto.accountId, dto.amountMinor, dto.rail, dto.externalRef, dto.idempotencyKey, dto.correlationId ?? this.institution.correlation(correlation));
  }

  @Post('payments/transition') @HttpCode(200)
  transition(@Body() dto: PaymentTransitionDto, @Headers('authorization') authorization?: string, @Headers('x-institution-nonce') nonce?: string, @Headers('x-correlation-id') correlation?: string) {
    const cred = this.cred(authorization, nonce, dto.institutionId);
    return this.institution.sandboxTransition(cred.keyId, cred.secret, cred.nonce, cred.institutionId, dto.paymentId, dto.state, dto.providerEventId ?? null, dto.signature ?? null, this.institution.correlation(correlation));
  }

  @Post('invoices') @HttpCode(200)
  invoice(@Body() dto: InvoiceDto, @Headers('authorization') authorization?: string, @Headers('x-institution-nonce') nonce?: string, @Headers('x-correlation-id') correlation?: string) {
    const cred = this.cred(authorization, nonce, dto.institutionId);
    return this.institution.sandboxInvoice(cred.keyId, cred.secret, cred.nonce, cred.institutionId, dto.periodStart, this.institution.correlation(correlation));
  }
}
