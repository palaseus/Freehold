import { Injectable } from '@nestjs/common';

// The authentication database pool lives in the auth process (src/auth-server.ts).
// Constructing it here would put AUTH_DATABASE_URL in the financial API.
@Injectable()
export class AuthDatabaseService {
  constructor() {
    throw new Error('The financial API must not open the authentication database');
  }
}
