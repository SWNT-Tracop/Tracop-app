import { AsyncLocalStorage } from 'node:async_hooks';
import { Inject, Injectable, OnApplicationShutdown } from '@nestjs/common';
import { drizzle, type NodePgDatabase } from 'drizzle-orm/node-postgres';
import { Pool } from 'pg';
import { APP_ENVIRONMENT, DATABASE_POOL } from './tokens.js';
import type { AppEnvironment } from './env.js';

export type AppDatabase = NodePgDatabase<Record<string, never>>;
export type DatabaseTransaction = Parameters<Parameters<AppDatabase['transaction']>[0]>[0];

@Injectable()
export class DatabaseService implements OnApplicationShutdown {
  readonly db: AppDatabase;
  private readonly transactions = new AsyncLocalStorage<AppDatabase | DatabaseTransaction>();

  constructor(
    @Inject(DATABASE_POOL) private readonly pool: Pool,
    @Inject(APP_ENVIRONMENT) environment: AppEnvironment,
  ) {
    void environment;
    this.db = drizzle(pool);
  }

  current(): AppDatabase | DatabaseTransaction {
    return this.transactions.getStore() ?? this.db;
  }

  async transaction<T>(operation: () => Promise<T>): Promise<T> {
    return this.db.transaction((transaction) => this.transactions.run(transaction, operation));
  }

  async onApplicationShutdown(): Promise<void> {
    await this.pool.end();
  }
}

export const createDatabasePool = (environment: AppEnvironment): Pool => {
  return new Pool({ connectionString: environment.DATABASE_URL });
};
