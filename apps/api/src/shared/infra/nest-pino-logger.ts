import type { LoggerService } from '@nestjs/common';
import type { Logger } from 'pino';

export class NestPinoLogger implements LoggerService {
  constructor(private readonly logger: Logger) {}

  log(_message: unknown, context?: string): void {
    this.logger.info({ context }, 'Application event');
  }

  error(_message: unknown, _stack?: string, context?: string): void {
    this.logger.error({ context }, 'Application error');
  }

  warn(_message: unknown, context?: string): void {
    this.logger.warn({ context }, 'Application warning');
  }

  debug(_message: unknown, context?: string): void {
    this.logger.debug({ context }, 'Application debug event');
  }

  verbose(_message: unknown, context?: string): void {
    this.logger.trace({ context }, 'Application verbose event');
  }
}
