# Commerce billing sample

Selected TypeScript/NestJS code from a multi-tenant commerce application.

The sample handles store subscription renewals, payment attempts, and uncertain provider outcomes.

## Start here

- [`subscription-lifecycle.processor.ts`](src/subscriptions/subscription-lifecycle.processor.ts): charge reservation, provider reconciliation, and settlement.
- [`myfatoorah-idempotency.ts`](src/subscriptions/myfatoorah-idempotency.ts): bounded replay using the original request timestamp.
- [`payment.entity.ts`](src/entities/payment.entity.ts) and [`invoice.entity.ts`](src/entities/invoice.entity.ts): uniqueness constraints for open attempts and renewal periods.

The included tests cover terminal paid settlement, expired replay protection, provider reconciliation, and replay-window boundaries. Processor tests mock the database and provider; they do not verify real database concurrency.

This is a source excerpt, not a standalone application. Application wiring and adjacent dependencies are omitted; imports retain their original structure with an anonymized database package name. Tests have not been run in this extraction.

Additional code and a walkthrough are available on request.
