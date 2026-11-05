import { Injectable } from '@nestjs/common';
import type { SyncOperationHandlerPort } from '../ports/sync-ports.js';

@Injectable()
export class SyncOperationHandlerRegistry {
  private readonly handlers = new Map<string, SyncOperationHandlerPort>();

  register(handler: SyncOperationHandlerPort): void {
    if (this.handlers.has(handler.entity))
      throw new Error(`Duplicate sync handler: ${handler.entity}`);
    this.handlers.set(handler.entity, handler);
  }

  get(entity: string): SyncOperationHandlerPort | undefined {
    return this.handlers.get(entity);
  }
}
