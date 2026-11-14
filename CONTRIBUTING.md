# Development

All rights are reserved. This document does not grant permission to use, modify, or distribute the source. Obtain the copyright holder's written permission before contributing. Do not submit third-party code without the necessary rights.

Authorized developers should use Node.js 22+, run `npm ci` in the root and web package, and follow `AGENTS.MD`. Run backend integration tests against disposable Docker infrastructure and web tests/builds before proposing changes. Include regression tests for correctness and security fixes.

Keep money in integer minor units. Preserve PostgreSQL posting authority, immutable journals, idempotency, ownership checks, role separation, and forward-only migrations. Never modify persistent test data destructively. Include no credentials or private operational evidence in changes.
