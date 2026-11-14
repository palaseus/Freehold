import { ArgumentsHost, Catch, ExceptionFilter, HttpException, Logger } from '@nestjs/common';
import type { FastifyReply } from 'fastify';
@Catch()
export class ErrorFilter implements ExceptionFilter {
  private readonly logger = new Logger(ErrorFilter.name);
  catch(error: unknown, host: ArgumentsHost) {
    const reply = host.switchToHttp().getResponse<FastifyReply>();
    if (error instanceof HttpException) {
      reply.status(error.getStatus()).send(error.getResponse()); return;
    }
    const db = error as { code?: string; message?: string } | null;
    const code = db?.code;
    if (code === '23505' && ['EMAIL_UNAVAILABLE','GOVERNANCE_IDEMPOTENCY_CONFLICT'].includes(db?.message ?? '')) { reply.status(409).send({ code: db?.message }); return; }
    if (code === '23505') { reply.status(409).send({ code: 'UNIQUE_CONFLICT' }); return; }
    if (code === '55000' && db?.message === 'FINANCIAL_WRITES_SUSPENDED') { reply.status(503).send({ code: db.message }); return; }
    const monetaryMessage = db?.message ?? '';
    if (monetaryMessage.startsWith('MONETARY_') || monetaryMessage.startsWith('INSTITUTION_') || monetaryMessage.startsWith('NETWORK_') || monetaryMessage.startsWith('PROGRAM_') || monetaryMessage === 'LIVE_MONETARY_ACTIVATION_REFUSED' || monetaryMessage === 'UNBACKED_CONVERSION_REFUSED') {
      const status = code === '42501' ? 403 : code === '55000' ? 409 : 400;
      reply.status(status).send({ code: monetaryMessage }); return;
    }
    if (code === '55000' && (db?.message?.startsWith('GOVERNANCE_') || db?.message?.startsWith('COMPLIANCE_'))) { reply.status(409).send({ code: db.message }); return; }
    if (code === '22023') {
      if (db?.message === 'IDEMPOTENCY_CONFLICT') { reply.status(409).send({ code: 'IDEMPOTENCY_CONFLICT' }); return; }
      const named = ['INVALID_STATEMENT_RANGE', 'INVALID_RISK_POLICY', 'INVALID_COMPLIANCE_CASE', 'INVALID_COMPLIANCE_NOTE', 'INVALID_COMPLIANCE_LINK', 'COMPLIANCE_CASE_NOT_FOUND', 'COMPLIANCE_REVIEWER_INVALID', 'INVALID_ACCOUNT_CONTROL', 'INVALID_SCHEDULE'];
      reply.status(400).send({ code: db?.message && named.includes(db.message) ? db.message : 'INVALID_REQUEST' }); return;
    }
    if (code === '42501') { reply.status(403).send({ code: 'FORBIDDEN' }); return; }
    if (code?.startsWith('22') || code === '23502') { reply.status(400).send({ code: 'INVALID_REQUEST' }); return; }
    if (['40P01', '40001', '55P03', '57014', '57P01', '57P02', '57P03', 'ECONNRESET', 'ECONNREFUSED', 'ETIMEDOUT', 'EPIPE'].includes(code ?? '') ||
      code?.startsWith('08') || (error instanceof Error && /connection|timeout/i.test(error.message))) {
      reply.status(503).send({ code: 'RETRY_SAME_IDEMPOTENCY_KEY' }); return;
    }
    // Never expose PostgreSQL detail fields, SQL, credentials, or request bodies.
    this.logger.error(`Request failed (${code ?? 'internal'})`);
    reply.status(500).send({ code: code === '23514' ? 'LEDGER_INVARIANT_VIOLATION' : 'INTERNAL_ERROR' });
  }
}
