import { Inject, Injectable } from '@nestjs/common';
import { DatabaseService } from '../../../../shared/infra/database.js';
import type { SyncUnitOfWorkPort } from '../../ports/sync-ports.js';

@Injectable()
export class SyncUnitOfWork implements SyncUnitOfWorkPort {
  constructor(@Inject(DatabaseService) private readonly database: DatabaseService) {}
  run<T>(operation: () => Promise<T>): Promise<T> {
    return this.database.transaction(operation);
  }
}
