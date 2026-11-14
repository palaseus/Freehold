export interface Session {
  user: { id: string; email: string; role: 'USER' | 'ADMIN'; twoFactorEnabled: boolean };
  csrfToken: string; expiresAt: string; twoFactorVerifiedAt: string | null; recentTwoFactorUntil: string | null; demoMode: boolean;
}
export interface Currency { code: string; name: string; minorUnitExponent: number; enabled: boolean }
export interface Account { id: string; currency: string; status: 'ACTIVE' | 'FROZEN' | 'CLOSED'; availableMinor: string; reservedMinor: string; totalMinor: string; ownerEmail?: string }
export interface Transaction { id: string; journalId: string; kind: string; direction: 'DEBIT' | 'CREDIT'; amountMinor: string; currency: string; effectiveAt: string; recordedAt: string; correlationId: string; counterpartyAccountId: string | null }
export interface History { items: Transaction[]; nextCursor: string | null }
export interface Operation { operationId: string; correlationId: string; state: 'COMPLETED' | 'REJECTED'; error?: string; transferId?: string; journalId?: string; [key: string]: unknown }
export interface ReconciliationReport { reconciliationId: string; balanced: boolean; checkedAt: string; debitsEqualCredits: boolean; totalsByCurrency: Array<{currency: string; debits: string; credits: string}>; projectionMismatchCount: number; projectionMismatches?: unknown[]; activeHoldMismatchCount: number; activeHoldMismatches?: unknown[] }
export interface AuditEvent { id: string; eventType: string; resourceId: string; operationId: string | null; correlationId: string; actorId: string | null; serviceIdentity: string | null; outcome: string; severity: string | null; metadata: Record<string, unknown>; recordedAt: string }
