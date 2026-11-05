import { Inject, Injectable } from '@nestjs/common';
import { CatalogService } from './catalog-service.js';
import type { LotProps } from '../domain/lot.js';

@Injectable()
export class DeleteLot {
  constructor(@Inject(CatalogService) private readonly catalog: CatalogService) {}

  execute(
    actor: { readonly sub: string; readonly role: string },
    lotId: string,
    version: number,
  ): Promise<LotProps> {
    return this.catalog.deleteLot(actor, lotId, version);
  }
}
