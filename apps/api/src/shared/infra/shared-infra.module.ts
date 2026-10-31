import { Global, Module } from '@nestjs/common';
import { APP_FILTER } from '@nestjs/core';
import { loadAppEnvironment } from './env.js';
import { createLogger } from './logger.js';
import { DatabaseService, createDatabasePool } from './database.js';
import { DrizzleUnitOfWork, unitOfWorkProvider } from './unit-of-work.js';
import { DrizzleOutboxWriter, outboxWriterProvider } from './outbox-writer.js';
import { HttpExceptionFilter } from './http-exception.filter.js';
import { ImmediateBackgroundDispatcher } from './background-dispatcher.js';
import {
  APP_CLOCK,
  APP_ENVIRONMENT,
  APP_LOGGER,
  BACKGROUND_DISPATCHER,
  DATABASE_POOL,
  OUTBOX_WRITER,
  UNIT_OF_WORK,
} from './tokens.js';
import { SystemClock } from './system-clock.js';

@Global()
@Module({
  providers: [
    { provide: APP_ENVIRONMENT, useFactory: () => loadAppEnvironment() },
    {
      provide: APP_LOGGER,
      inject: [APP_ENVIRONMENT],
      useFactory: (env: ReturnType<typeof loadAppEnvironment>) => createLogger(env.NODE_ENV),
    },
    { provide: DATABASE_POOL, inject: [APP_ENVIRONMENT], useFactory: createDatabasePool },
    DatabaseService,
    DrizzleUnitOfWork,
    unitOfWorkProvider,
    DrizzleOutboxWriter,
    outboxWriterProvider,
    HttpExceptionFilter,
    { provide: APP_FILTER, useClass: HttpExceptionFilter },
    { provide: APP_FILTER, useClass: HttpExceptionFilter },
    SystemClock,
    { provide: APP_CLOCK, useExisting: SystemClock },
    ImmediateBackgroundDispatcher,
    { provide: BACKGROUND_DISPATCHER, useExisting: ImmediateBackgroundDispatcher },
  ],
  exports: [
    APP_ENVIRONMENT,
    APP_LOGGER,
    APP_CLOCK,
    DATABASE_POOL,
    DatabaseService,
    UNIT_OF_WORK,
    OUTBOX_WRITER,
    BACKGROUND_DISPATCHER,
    HttpExceptionFilter,
  ],
})
export class SharedInfraModule {}
