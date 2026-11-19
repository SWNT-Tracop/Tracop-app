import { AsyncLocalStorage } from 'node:async_hooks';
import { Inject, Injectable, OnApplicationShutdown } from '@nestjs/common';
import { drizzle, type NodePgDatabase } from 'drizzle-orm/node-postgres';
import { sql } from 'drizzle-orm';
import { Pool } from 'pg';
import { APP_ENVIRONMENT, DATABASE_POOL } from './tokens.js';
import type { AppEnvironment } from './env.js';
import { DomainError } from '../kernel/domain-error.js';

export type AppDatabase = NodePgDatabase<Record<string, never>>;
export type DatabaseTransaction = Parameters<Parameters<AppDatabase['transaction']>[0]>[0];

@Injectable()
export class DatabaseService implements OnApplicationShutdown {
  readonly db: AppDatabase;
  private readonly transactions = new AsyncLocalStorage<AppDatabase | DatabaseTransaction>();
  private readonly lockTimeoutMs: number;
  private readonly statementTimeoutMs: number;

  constructor(
    @Inject(DATABASE_POOL) private readonly pool: Pool,
    @Inject(APP_ENVIRONMENT) environment: AppEnvironment,
  ) {
    this.lockTimeoutMs = environment.ORDER_LOCK_TIMEOUT_MS;
    this.statementTimeoutMs = environment.ORDER_STATEMENT_TIMEOUT_MS;
    this.db = drizzle(pool);
  }

  current(): AppDatabase | DatabaseTransaction {
    return this.transactions.getStore() ?? this.db;
  }

  async transaction<T>(operation: () => Promise<T>): Promise<T> {
    const current = this.transactions.getStore();
    if (current) return operation();
    try {
      return await this.db.transaction(async (transaction) => {
        await transaction.execute(sql.raw(`SET LOCAL lock_timeout = '${this.lockTimeoutMs}ms'`));
        await transaction.execute(
          sql.raw(`SET LOCAL statement_timeout = '${this.statementTimeoutMs}ms'`),
        );
        return this.transactions.run(transaction, operation);
      });
    } catch (error) {
      let code = '';
      let current: unknown = error;
      for (
        let depth = 0;
        depth < 4 && current !== null && typeof current === 'object';
        depth += 1
      ) {
        if ('code' in current) {
          code = String((current as { code: unknown }).code);
          if (code) break;
        }
        current = 'cause' in current ? (current as { cause: unknown }).cause : null;
      }
      if (code === '55P03')
        throw new DomainError(
          'La operación excedió el tiempo de espera del bloqueo.',
          'lock_timeout',
        );
      if (code === '57014')
        throw new DomainError(
          'La operación excedió el tiempo máximo de ejecución.',
          'statement_timeout',
        );
      throw error;
    }
  }

  async onApplicationShutdown(): Promise<void> {
    await this.pool.end();
  }
}

export const createDatabasePool = (environment: AppEnvironment): Pool => {
  return new Pool({ connectionString: environment.DATABASE_URL });
};
