import { defineConfig } from 'drizzle-kit';

export default defineConfig({
  dialect: 'postgresql',
  driver: 'pglite',
  schema: './src/server/db/schema.ts',
  out: './src/server/db/migrations',
  dbCredentials: { url: './pam-data/db' },
});
