import { readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { NestFactory } from '@nestjs/core';
import { AppModule } from '../src/bootstrap/app.module.js';
import { createOpenApiDocument } from '../src/shared/infra/swagger.js';

const outputPath = resolve(process.cwd(), '../../docs/openapi.json');

const exportOpenApi = async (): Promise<void> => {
  process.env.NODE_ENV = 'test';
  process.env.TELEGRAM_MODE = 'webhook';
  process.env.DATABASE_URL = 'postgresql://openapi:openapi@127.0.0.1:5432/openapi';
  process.env.JWT_SECRET = 'openapi-export-only-jwt-secret-not-for-authentication';
  process.env.OTP_HMAC_SECRET = 'openapi-export-only-otp-hmac-secret';
  process.env.RATE_LIMIT_HMAC_SECRET = 'openapi-export-only-rate-limit-secret';
  const app = await NestFactory.create(AppModule, { bodyParser: false });
  try {
    const document = createOpenApiDocument(app);
    const generated = `${JSON.stringify(document, null, 2)}\n`;
    if (process.argv.includes('--check')) {
      const current = await readFile(outputPath, 'utf8').catch(() => '');
      if (current !== generated) {
        throw new Error(
          'docs/openapi.json is stale. Run `pnpm openapi:export` and commit the generated file.',
        );
      }
      return;
    }
    await writeFile(outputPath, generated);
  } finally {
    await app.close();
  }
};

await exportOpenApi();
