import {
  Body,
  Controller,
  Get,
  Inject,
  Param,
  Patch,
  Post,
  Query,
  Req,
  UseGuards,
} from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { createCipheriv, createDecipheriv, createHash, randomBytes } from 'node:crypto';
import {
  createCategorySchema,
  createLotSchema,
  createProductSchema,
  lotCursorPayloadSchema,
  searchLotsQuerySchema,
} from '@tracop/contracts';
import { AuthGuard, type AuthenticatedRequest, Roles } from '../../../../shared/auth/index.js';
import { DomainError } from '../../../../shared/kernel/domain-error.js';
import { InMemorySearchRateLimiter } from '../../../../shared/infra/search-rate-limiter.js';
import { APP_ENVIRONMENT } from '../../../../shared/infra/tokens.js';
import type { AppEnvironment } from '../../../../shared/infra/env.js';
import { CatalogService } from '../../application/catalog-service.js';
import { PROVIDER_DIRECTORY, type ProviderDirectoryPort } from '../../ports/catalog-ports.js';

@ApiTags('catalog')
@ApiBearerAuth()
@UseGuards(AuthGuard)
@Controller('catalog')
export class CatalogController {
  constructor(@Inject(CatalogService) private readonly catalog: CatalogService) {}

  @Get('categories') async listCategories() {
    return this.catalog.listCategories();
  }
  @Post('categories') @Roles('operator', 'admin') async createCategory(
    @Body() body: unknown,
    @Req() req: AuthenticatedRequest,
  ) {
    return this.catalog.createCategory(req.identity!, createCategorySchema.parse(body));
  }
  @Patch('categories/:id') @Roles('operator', 'admin') async updateCategory(
    @Param('id') id: string,
    @Body() body: unknown,
    @Req() req: AuthenticatedRequest,
  ) {
    const input = createCategorySchema.pick({ name: true }).parse(body);
    return this.catalog.updateCategory(req.identity!, id, input);
  }
  @Get('products') async listProducts(@Query() query: Record<string, string>) {
    return this.catalog.listProducts({
      ...(query.categoryId ? { categoryId: query.categoryId } : {}),
      ...(query.q ? { q: query.q } : {}),
    });
  }
  @Post('products') @Roles('operator', 'admin') async createProduct(
    @Body() body: unknown,
    @Req() req: AuthenticatedRequest,
  ) {
    return this.catalog.createProduct(req.identity!, createProductSchema.parse(body) as never);
  }
  @Patch('products/:id') @Roles('operator', 'admin') async updateProduct(
    @Param('id') id: string,
    @Body() body: unknown,
    @Req() req: AuthenticatedRequest,
  ) {
    const input = createProductSchema.omit({ id: true }).parse(body);
    return this.catalog.updateProduct(req.identity!, id, input as never);
  }
}

@ApiTags('lots')
@ApiBearerAuth()
@UseGuards(AuthGuard)
@Controller('lots')
export class LotsController {
  constructor(
    @Inject(CatalogService) private readonly catalog: CatalogService,
    @Inject(PROVIDER_DIRECTORY) private readonly providers: ProviderDirectoryPort,
    @Inject(InMemorySearchRateLimiter)
    private readonly searchRateLimiter: InMemorySearchRateLimiter,
    @Inject(APP_ENVIRONMENT) private readonly env: AppEnvironment,
  ) {}

  @Post() @Roles('producer', 'supplier') async create(
    @Body() body: unknown,
    @Req() req: AuthenticatedRequest,
  ) {
    const input = createLotSchema.parse(body);
    return this.toResponse(
      await this.catalog.createLot(req.identity!, {
        ...input,
        unitPrice: BigInt(input.unitPrice),
        availableFrom: new Date(input.availableFrom),
        availableUntil: new Date(input.availableUntil),
      }),
      req.identity!.sub,
    );
  }
  @Get('mine') @Roles('producer', 'supplier') async mine(@Req() req: AuthenticatedRequest) {
    return Promise.all(
      (await this.catalog.getMyLots(req.identity!)).map((lot) =>
        this.toResponse(lot, req.identity!.sub),
      ),
    );
  }
  @Get() async search(@Query() query: unknown, @Req() req: AuthenticatedRequest) {
    const input = searchLotsQuerySchema.parse(query);
    if (input.radiusKm !== undefined && input.radiusKm > this.env.CATALOG_SEARCH_RADIUS_MAX_KM) {
      throw new DomainError('El radio supera el máximo permitido.', 'invalid_search_radius');
    }
    this.searchRateLimiter.consume(req.identity!.sub);
    let cursor: ReturnType<typeof lotCursorPayloadSchema.parse> | undefined;
    if (input.cursor) {
      try {
        cursor = lotCursorPayloadSchema.parse(this.decodeCursor(input.cursor));
      } catch {
        throw new DomainError('El cursor de búsqueda no es válido.', 'invalid_cursor');
      }
      if (cursor.sort !== input.sort)
        throw new DomainError('El cursor no corresponde al orden solicitado.', 'invalid_cursor');
    }
    const page = await this.catalog.searchVisibleLots({
      limit: input.limit,
      sort: input.sort,
      ...(cursor ? { cursor } : {}),
      ...(input.categoryId ? { categoryId: input.categoryId } : {}),
      ...(input.productId ? { productId: input.productId } : {}),
      ...(input.q ? { q: input.q } : {}),
      ...(input.minPrice !== undefined ? { minPrice: input.minPrice } : {}),
      ...(input.maxPrice !== undefined ? { maxPrice: input.maxPrice } : {}),
      ...(input.availableFrom ? { availableFrom: new Date(input.availableFrom) } : {}),
      ...(input.availableUntil ? { availableUntil: new Date(input.availableUntil) } : {}),
      ...(input.lat !== undefined ? { lat: input.lat } : {}),
      ...(input.lng !== undefined ? { lng: input.lng } : {}),
      ...(input.radiusKm !== undefined ? { radiusKm: input.radiusKm } : {}),
      ...(cursor ? { cursor } : {}),
    });
    return {
      items: await Promise.all(
        page.items.map(({ lot, distanceKm }) =>
          this.toResponse(lot, req.identity!.sub, distanceKm),
        ),
      ),
      ...(page.nextCursor ? { nextCursor: this.encodeCursor(page.nextCursor) } : {}),
    };
  }
  @Get(':id') async get(@Param('id') id: string, @Req() req: AuthenticatedRequest) {
    return this.toResponse(await this.catalog.getLot(req.identity!, id), req.identity!.sub);
  }
  @Patch(':id') @Roles('producer', 'supplier') async update(
    @Param('id') id: string,
    @Body() body: unknown,
    @Req() req: AuthenticatedRequest,
  ) {
    if (
      typeof body !== 'object' ||
      body === null ||
      !('version' in body) ||
      typeof body.version !== 'number'
    )
      throw new DomainError('Incluye la versión conocida.', 'invalid_version');
    const { version, ...input } = body as { version: number; [key: string]: unknown };
    return this.toResponse(
      await this.catalog.updateLot(req.identity!, id, version, input as never),
      req.identity!.sub,
    );
  }
  @Post(':id/publish') @Roles('producer', 'supplier') async publish(
    @Param('id') id: string,
    @Body() body: unknown,
    @Req() req: AuthenticatedRequest,
  ) {
    const version = this.parseVersion(body);
    return this.toResponse(
      await this.catalog.publishLot(req.identity!, id, version),
      req.identity!.sub,
    );
  }
  @Post(':id/cancel') @Roles('producer', 'supplier') async cancel(
    @Param('id') id: string,
    @Body() body: unknown,
    @Req() req: AuthenticatedRequest,
  ) {
    const version = this.parseVersion(body);
    return this.toResponse(
      await this.catalog.cancelLot(req.identity!, id, version),
      req.identity!.sub,
    );
  }

  private parseVersion(body: unknown): number {
    if (
      typeof body !== 'object' ||
      body === null ||
      !('version' in body) ||
      !Number.isInteger(body.version)
    )
      throw new DomainError('Incluye la versión conocida.', 'invalid_version');
    return body.version as number;
  }
  private async toResponse(
    lot:
      | Awaited<ReturnType<CatalogService['getLot']>>
      | Awaited<ReturnType<CatalogService['createLot']>>,
    viewerId: string,
    distanceKm?: number,
  ) {
    const [provider] = await this.providers
      .getProviderPublicSummaries([lot.providerId])
      .then((map) => [map.get(lot.providerId)]);
    if (!provider)
      throw new DomainError('Perfil público del proveedor no encontrado.', 'not_found');
    const { locationLat, locationLng, ...publicFields } = lot;
    return {
      ...publicFields,
      unitPrice: lot.unitPrice.toString(),
      provider,
      ...(viewerId === lot.providerId ? { locationLat, locationLng } : {}),
      ...(viewerId !== lot.providerId && distanceKm !== undefined
        ? { distanceKm: Math.max(1, Math.round(distanceKm)) }
        : {}),
    };
  }

  private encodeCursor(payload: unknown): string {
    const key = createHash('sha256').update(this.env.JWT_SECRET).digest();
    const nonce = randomBytes(12);
    const cipher = createCipheriv('aes-256-gcm', key, nonce);
    const encrypted = Buffer.concat([
      cipher.update(JSON.stringify(payload), 'utf8'),
      cipher.final(),
    ]);
    return Buffer.concat([nonce, cipher.getAuthTag(), encrypted]).toString('base64url');
  }

  private decodeCursor(cursor: string): unknown {
    const bytes = Buffer.from(cursor, 'base64url');
    if (bytes.length < 29) throw new Error('Invalid cursor.');
    const key = createHash('sha256').update(this.env.JWT_SECRET).digest();
    const decipher = createDecipheriv('aes-256-gcm', key, bytes.subarray(0, 12));
    decipher.setAuthTag(bytes.subarray(12, 28));
    return JSON.parse(
      Buffer.concat([decipher.update(bytes.subarray(28)), decipher.final()]).toString('utf8'),
    ) as unknown;
  }
}
