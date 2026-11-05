import { Inject, Injectable } from '@nestjs/common';
import { DatabaseService } from './database.js';
import { UNIT_OF_WORK } from './tokens.js';

export interface UnitOfWork {
  run<T>(operation: () => Promise<T>): Promise<T>;
}

@Injectable()
export class DrizzleUnitOfWork implements UnitOfWork {
  constructor(@Inject(DatabaseService) private readonly database: DatabaseService) {}

  run<T>(operation: () => Promise<T>): Promise<T> {
    return this.database.transaction(operation);
  }
}

export const unitOfWorkProvider = {
  provide: UNIT_OF_WORK,
  useExisting: DrizzleUnitOfWork,
};
