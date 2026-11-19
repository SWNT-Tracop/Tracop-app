import { readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { Test } from '@nestjs/testing';
import { AppModule } from '../src/bootstrap/app.module.js';
import { createOpenApiDocument } from '../src/shared/infra/swagger.js';

describe('OpenAPI export', () => {
  it('exports or verifies docs/openapi.json', async () => {
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    const app = moduleRef.createNestApplication({ bodyParser: false });
    await app.init();
    try {
      const document = createOpenApiDocument(app);
      const generated = `${JSON.stringify(document, null, 2)}\n`;
      const outputPath = resolve(process.cwd(), '../../docs/openapi.json');
      if (process.env.OPENAPI_EXPORT === 'true') {
        await writeFile(outputPath, generated);
      } else {
        const current = await readFile(outputPath, 'utf8').catch(() => '');
        expect(JSON.parse(current)).toEqual(document);
      }
    } finally {
      await app.close();
    }
  });
});
