export interface AuthUser {
  id: string;
  status: 'ACTIVE' | 'DISABLED';
  role: 'USER' | 'ADMIN';
  auth_version: string;
  two_factor_enabled: boolean;
}
export interface SessionRecord {
  userId: string;
  authVersion: string;
  csrfToken: string;
  expiresAt: number;
  twoFactorAt: number | null;
  dbSecret: string;
}
export interface Principal {
  user: AuthUser;
  session: SessionRecord;
}
declare module 'fastify' {
  interface FastifyRequest {
    principal?: Principal;
    sessionToken?: string;
  }
}
