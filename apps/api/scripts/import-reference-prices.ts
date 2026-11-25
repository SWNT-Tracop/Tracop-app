/**
 * Imports a reference price CSV (DANE-SIPSA, converted by a person; format in
 * src/modules/recommendations/domain/reference-csv.ts). Importing the same file again changes
 * nothing. Usage: pnpm recommendations:import-reference-prices <file.csv>
 */
import { readFile, stat } from 'node:fs/promises';
import { NestFactory } from '@nestjs/core';
import { AppModule } from '../src/bootstrap/app.module.js';
import {
  RECOMMENDATIONS_SERVICE,
  type RecommendationsService,
} from '../src/modules/recommendations/index.js';

const MAX_FILE_BYTES = 20 * 1024 * 1024;
const path = process.argv[2];
if (!path) {
  process.stderr.write('Usage: pnpm recommendations:import-reference-prices <file.csv>\n');
  process.exit(2);
}
if ((await stat(path)).size > MAX_FILE_BYTES) {
  process.stderr.write('The file is larger than 20 MB.\n');
  process.exit(2);
}
const content = await readFile(path, 'utf8');
const app = await NestFactory.createApplicationContext(AppModule, { logger: false });
try {
  const result = await app
    .get<RecommendationsService>(RECOMMENDATIONS_SERVICE)
    .importReferencePrices(content);
  if (result.status === 'invalid') {
    process.stderr.write(`Not imported:\n${result.errors.join('\n')}\n`);
    process.exitCode = 1;
  } else if (result.status === 'already_imported') {
    process.stdout.write(`Already imported (${result.rows} rows); nothing changed.\n`);
  } else {
    process.stdout.write(`Imported ${result.rows} reference prices.\n`);
  }
} finally {
  await app.close();
}
