import type { INestApplication } from '@nestjs/common';
import { DocumentBuilder, SwaggerModule } from '@nestjs/swagger';

export const createOpenApiDocument = (app: INestApplication) => {
  const config = new DocumentBuilder()
    .setTitle('TRACOP API')
    .setDescription('Contratos HTTP de TRACOP. No incluye el webhook interno de Telegram.')
    .setVersion('0.1.0')
    .addBearerAuth()
    .build();
  return SwaggerModule.createDocument(app, config);
};

export const setupSwagger = (app: INestApplication, nodeEnv: string): boolean => {
  if (nodeEnv === 'production') return false;
  SwaggerModule.setup('docs', app, createOpenApiDocument(app), { jsonDocumentUrl: 'docs-json' });
  return true;
};
