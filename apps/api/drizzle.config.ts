import { defineConfig } from 'drizzle-kit';

export default defineConfig({ dialect: 'postgresql', schema: './src/shared/**/*.ts', out: './drizzle', dbCredentials: { url: process.env.DATABASE_URL ?? 'postgres://tracop:tracop@localhost:5432/tracop' } });
