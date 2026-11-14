# Client and ledger boundary

The browser is a reader and request form. The NestJS API authenticates each request, applies authorization and validation, and calls the restricted PostgreSQL functions. PostgreSQL remains the authority for posted entries and the available and reserved balance projections.

The client displays balances returned by the API and formats their integer minor-unit strings using currency precision returned by the API. It does not add entries together, derive available funds, or calculate transfer results. A transfer is shown as COMMITTED or REJECTED only when an authoritative durable operation response is available. Network errors and server failures remain UNKNOWN; an idempotency-key/payload conflict remains CONFLICT until the stored result is resolved. The original payload and `Idempotency-Key` stay available for identical-key retry and status lookup.

This boundary avoids two competing versions of financial state. A client calculation could be stale, incomplete, or wrong about concurrent activity; the ledger API has the locking and durable transaction result needed to decide. Next.js only proxies allowlisted REST calls and has no database credentials.

The Docker Compose stack is the supported way to exercise this full boundary locally: Next.js, NestJS, the reconciliation worker, PostgreSQL, and Redis run as separate services and communicate over the Compose network. The client never calculates balances; it displays the available and reserved projections returned by the API. The worker consumes durable outbox events and compares ledger entries, account projections, and active holds; mismatches create a high-severity audit event and are never corrected automatically.
