import { defineConfig } from 'prisma/config';

// Required by Prisma 7. Only `prisma generate` runs against this package, and
// generate never connects, so a placeholder URL is fine when DATABASE_URL is
// unset. The integration tests start their own Postgres via Testcontainers.
export default defineConfig({
  schema: 'prisma/schema.prisma',
  datasource: {
    url: process.env['DATABASE_URL'] ?? 'postgresql://localhost:5432/idempotix',
  },
});
