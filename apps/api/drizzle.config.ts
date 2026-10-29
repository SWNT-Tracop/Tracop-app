import { defineConfig } from 'drizzle-kit';
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { loadEnvFile } from 'node:process';

const envPath = resolve('../../.env');
if (existsSync(envPath)) loadEnvFile(envPath);

export default defineConfig({
  dialect: 'postgresql',
  schema: './src/shared/**/*.ts',
  out: './drizzle',
  dbCredentials: { url: process.env.DATABASE_URL ?? '' },
});
