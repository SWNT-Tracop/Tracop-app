import {
  Body,
  Controller,
  Delete,
  Get,
  Inject,
  Param,
  Patch,
  Post,
  Query,
  Req,
  UseGuards,
} from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiParam, ApiQuery, ApiTags } from '@nestjs/swagger';
import { createCipheriv, createDecipheriv, createHash, randomBytes } from 'node:crypto';
import {
  createCategorySchema,
  createLotSchema,
  createProductSchema,
  lotCursorPayloadSchema,
  lotVersionSchema,
  searchLotsQuerySchema,
  updateLotRequestSchema,
} from '@tracop/contracts';
import { AuthGuard, type AuthenticatedRequest, Roles } from '../../../../shared/auth/index.js';
import { DomainError } from '../../../../shared/kernel/domain-error.js';
import { isWithinColombia } from '../../../../shared/kernel/geo.js';
import { InMemorySearchRateLimiter } from '../../../../shared/infra/search-rate-limiter.js';
import { APP_ENVIRONMENT } from '../../../../shared/infra/tokens.js';
import type { AppEnvironment } from '../../../../shared/infra/env.js';
import { CatalogService } from '../../application/catalog-service.js';
import { DeleteLot } from '../../application/delete-lot.js';
import { PROVIDER_DIRECTORY, type ProviderDirectoryPort } from '../../ports/catalog-ports.js';
import { serializeLotForViewer } from './lot-response.js';
import { ApiErrorResponses, ApiZodBody, ApiZodResponse } from '../../../../shared/infra/openapi.js';
import { z } from 'zod';
import { LotPhotoService } from '../../application/lot-photo-service.js';

const uuidV7Schema = z
  .string()
  .regex(/^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i);
const createPhotoUploadSchema = z.object({ photoId: uuidV7Schema });
const reorderPhotosSchema = z.object({ photoIds: z.array(uuidV7Schema).max(5) });
const photoUploadResponseSchema = z.object({
  state: z.enum(['pending', 'processing', 'ready']),
  uploadPolicy: z
    .object({
      url: z.string().url(),
      fields: z.record(z.string(), z.string()),
      expiresAt: z.string().datetime(),
    })
    .optional(),
});

@ApiTags('catalog')
@ApiBearerAuth()
@UseGuards(AuthGuard)
@Controller('catalog')
export class CatalogController {
  constructor(@Inject(CatalogService) private readonly catalog: CatalogService) {}

  @Get('categories')
  @ApiOperation({
    summary: 'Listar categorías',
    description: 'Devuelve la taxonomía activa del catálogo.',
  })
  @ApiErrorResponses(401, 403)
  async listCategories() {
    return this.catalog.listCategories();
  }
  @Post('categories')
  @Roles('operator', 'admin')
  @ApiOperation({
    summary: 'Crear categoría',
    description:
      'Crea una categoría de catálogo con ID UUID generado por el cliente; el contrato valida formato UUID, no la versión.',
  })
  @ApiZodBody(createCategorySchema, {
    id: '018f47a2-8b45-7cc2-9a1e-123456789abc',
    name: 'Hortalizas',
    parentId: null,
  })
  @ApiErrorResponses(400, 401, 403, 409)
  async createCategory(@Body() body: unknown, @Req() req: AuthenticatedRequest) {
    return this.catalog.createCategory(req.identity!, createCategorySchema.parse(body));
  }
  @Patch('categories/:id')
  @Roles('operator', 'admin')
  @ApiOperation({
    summary: 'Actualizar categoría',
    description: 'Actualiza el nombre de una categoría existente.',
  })
  @ApiParam({
    name: 'id',
    schema: { type: 'string', format: 'uuid' },
    example: '018f47a2-8b45-7cc2-9a1e-123456789abc',
  })
  @ApiErrorResponses(400, 401, 403, 404, 409)
  async updateCategory(
    @Param('id') id: string,
    @Body() body: unknown,
    @Req() req: AuthenticatedRequest,
  ) {
    const input = createCategorySchema.pick({ name: true }).parse(body);
    return this.catalog.updateCategory(req.identity!, id, input);
  }
  @Get('products')
  @ApiOperation({
    summary: 'Listar productos',
    description: 'Filtra el catálogo por categoría y texto de búsqueda.',
  })
  @ApiQuery({ name: 'categoryId', required: false, schema: { type: 'string', format: 'uuid' } })
  @ApiQuery({ name: 'q', required: false, schema: { type: 'string', maxLength: 120 } })
  @ApiErrorResponses(400, 401, 403)
  async listProducts(@Query() query: Record<string, string>) {
    return this.catalog.listProducts({
      ...(query.categoryId ? { categoryId: query.categoryId } : {}),
      ...(query.q ? { q: query.q } : {}),
    });
  }
  @Post('products')
  @Roles('operator', 'admin')
  @ApiOperation({
    summary: 'Crear producto',
    description: 'Añade un producto con unidad y atributos estructurados.',
  })
  @ApiZodBody(createProductSchema, {
    id: '018f47a2-8b45-7cc2-9a1e-123456789abd',
    categoryId: '018f47a2-8b45-7cc2-9a1e-123456789abc',
    name: 'Tomate chonto',
    unit: 'kg',
    attributes: { color: 'rojo' },
  })
  @ApiErrorResponses(400, 401, 403, 404, 409)
  async createProduct(@Body() body: unknown, @Req() req: AuthenticatedRequest) {
    return this.catalog.createProduct(req.identity!, createProductSchema.parse(body) as never);
  }
  @Patch('products/:id')
  @Roles('operator', 'admin')
  @ApiOperation({
    summary: 'Actualizar producto',
    description: 'Actualiza los datos de un producto existente.',
  })
  @ApiParam({
    name: 'id',
    schema: { type: 'string', format: 'uuid' },
    example: '018f47a2-8b45-7cc2-9a1e-123456789abd',
  })
  @ApiErrorResponses(400, 401, 403, 404, 409)
  async updateProduct(
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
    @Inject(DeleteLot) private readonly deleteDraft: DeleteLot,
    @Inject(LotPhotoService) private readonly lotPhotos: LotPhotoService,
    @Inject(PROVIDER_DIRECTORY) private readonly providers: ProviderDirectoryPort,
    @Inject(InMemorySearchRateLimiter)
    private readonly searchRateLimiter: InMemorySearchRateLimiter,
    @Inject(APP_ENVIRONMENT) private readonly env: AppEnvironment,
  ) {}

  @Post()
  @Roles('producer', 'supplier')
  @ApiOperation({
    summary: 'Crear lote',
    description:
      'Registra un lote en estado borrador. quantityMilli expresa milésimas de unidad; unitPrice está expresado en pesos enteros.',
  })
  @ApiZodBody(createLotSchema, {
    id: '018f47a2-8b45-7cc2-9a1e-123456789abe',
    productId: '018f47a2-8b45-7cc2-9a1e-123456789abd',
    quantityMilli: '25000',
    unit: 'kg',
    unitPrice: 3200,
    qualityGrade: 'Primera',
    availableFrom: '2026-11-05T12:00:00.000Z',
    availableUntil: '2026-11-10T12:00:00.000Z',
    locationLat: 5.5353,
    locationLng: -73.3678,
  })
  @ApiErrorResponses(400, 401, 403, 404, 409)
  async create(@Body() body: unknown, @Req() req: AuthenticatedRequest) {
    const input = createLotSchema.parse(body);
    return this.toResponse(
      await this.catalog.createLot(req.identity!, {
        ...input,
        quantityMilli: BigInt(input.quantityMilli),
        unitPrice: BigInt(input.unitPrice),
        availableFrom: new Date(input.availableFrom),
        availableUntil: new Date(input.availableUntil),
      }),
      req.identity!.sub,
    );
  }
  @Get('mine')
  @Roles('producer', 'supplier')
  @ApiOperation({
    summary: 'Listar mis lotes',
    description: 'Devuelve los lotes pertenecientes al proveedor autenticado.',
  })
  @ApiErrorResponses(401, 403)
  async mine(@Req() req: AuthenticatedRequest) {
    return Promise.all(
      (await this.catalog.getMyLots(req.identity!)).map((lot) =>
        this.toResponse(lot, req.identity!.sub),
      ),
    );
  }
  @Get()
  @ApiOperation({
    summary: 'Buscar lotes visibles',
    description:
      'Filtros: categoría, producto, texto, precio, disponibilidad y ubicación (lat, lng y radiusKm se envían juntos). sort admite price, distance, availability y recent. limit va de 1 a 50 (por defecto 20). cursor es opaco y cifrado; reenvíelo sin modificar. distanceKm se devuelve como entero para terceros; la ubicación precisa solo se incluye al propietario. El radio máximo efectivo es configurable por el servidor.',
  })
  @ApiQuery({
    name: 'q',
    required: false,
    schema: { type: 'string', maxLength: 120 },
    example: 'tomate orgánico',
  })
  @ApiQuery({ name: 'categoryId', required: false, schema: { type: 'string', format: 'uuid' } })
  @ApiQuery({ name: 'productId', required: false, schema: { type: 'string', format: 'uuid' } })
  @ApiQuery({ name: 'minPrice', required: false, schema: { type: 'integer', minimum: 0 } })
  @ApiQuery({ name: 'maxPrice', required: false, schema: { type: 'integer', minimum: 0 } })
  @ApiQuery({
    name: 'availableFrom',
    required: false,
    schema: { type: 'string', format: 'date-time' },
  })
  @ApiQuery({
    name: 'availableUntil',
    required: false,
    schema: { type: 'string', format: 'date-time' },
  })
  @ApiQuery({ name: 'lat', required: false, schema: { type: 'number', minimum: -90, maximum: 90 } })
  @ApiQuery({
    name: 'lng',
    required: false,
    schema: { type: 'number', minimum: -180, maximum: 180 },
  })
  @ApiQuery({
    name: 'radiusKm',
    required: false,
    schema: { type: 'number', minimum: 0, exclusiveMinimum: true, maximum: 500 },
  })
  @ApiQuery({
    name: 'sort',
    required: false,
    schema: {
      type: 'string',
      enum: ['price', 'distance', 'availability', 'recent'],
      default: 'recent',
    },
  })
  @ApiQuery({
    name: 'limit',
    required: false,
    schema: { type: 'integer', minimum: 1, maximum: 50, default: 20 },
  })
  @ApiQuery({
    name: 'cursor',
    required: false,
    schema: { type: 'string', maxLength: 1024 },
    description: 'Cursor opaco de la página anterior; no decodificar ni modificar.',
  })
  @ApiErrorResponses(400, 401, 403, 429)
  async search(@Query() query: unknown, @Req() req: AuthenticatedRequest) {
    const input = searchLotsQuerySchema.parse(query);
    if (input.radiusKm !== undefined && input.radiusKm > this.env.CATALOG_SEARCH_RADIUS_MAX_KM) {
      throw new DomainError('El radio supera el máximo permitido.', 'invalid_search_radius');
    }
    if (
      input.lat !== undefined &&
      input.lng !== undefined &&
      !isWithinColombia(input.lat, input.lng)
    )
      throw new DomainError(
        'Las coordenadas deben estar dentro de Colombia.',
        'invalid_coordinates',
      );
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
          this.toResponse(lot, req.identity!.sub, distanceKm, false, lot.availableQuantityMilli),
        ),
      ),
      ...(page.nextCursor ? { nextCursor: this.encodeCursor(page.nextCursor) } : {}),
    };
  }
  @Get(':id')
  @ApiOperation({
    summary: 'Consultar lote',
    description:
      'Devuelve el lote visible para la cuenta autenticada, ocultando coordenadas exactas a terceros.',
  })
  @ApiParam({
    name: 'id',
    schema: { type: 'string', format: 'uuid' },
    example: '018f47a2-8b45-7cc2-9a1e-123456789abe',
  })
  @ApiErrorResponses(401, 403, 404)
  async get(@Param('id') id: string, @Req() req: AuthenticatedRequest) {
    return this.toResponse(
      await this.catalog.getLot(req.identity!, id),
      req.identity!.sub,
      undefined,
      true,
    );
  }

  @Post(':id/photos')
  @Roles('producer', 'supplier')
  @ApiOperation({
    summary: 'Preparar carga de foto del lote',
    description:
      'Reserva una foto y devuelve una política POST prefirmada de un solo objeto y tamaño limitado.',
  })
  @ApiParam({ name: 'id', schema: { type: 'string', format: 'uuid' } })
  @ApiZodBody(createPhotoUploadSchema, { photoId: '0190f47a-8b45-7cc2-9a1e-123456789abc' })
  @ApiZodResponse(201, photoUploadResponseSchema, {
    state: 'pending',
    uploadPolicy: {
      url: 'https://storage.example/upload',
      fields: { key: 'incoming/synthetic-random-key' },
      expiresAt: '2026-11-03T12:05:00.000Z',
    },
  })
  @ApiErrorResponses(400, 401, 403, 404, 409, 429, 500, 503)
  async preparePhotoUpload(
    @Param('id') lotId: string,
    @Body() body: unknown,
    @Req() req: AuthenticatedRequest,
  ) {
    const { photoId } = createPhotoUploadSchema.parse(body);
    return this.lotPhotos.prepareUpload(req.identity!, lotId, photoId);
  }

  @Post(':id/photos/:photoId/confirm')
  @Roles('producer', 'supplier')
  @ApiOperation({
    summary: 'Confirmar foto del lote',
    description: 'Valida, orienta y recodifica la imagen sin metadatos privados.',
  })
  @ApiParam({ name: 'id', schema: { type: 'string', format: 'uuid' } })
  @ApiParam({ name: 'photoId', schema: { type: 'string', format: 'uuid' } })
  @ApiZodResponse(201, photoUploadResponseSchema, { state: 'ready' })
  @ApiErrorResponses(401, 403, 404, 409, 410, 422, 503)
  async confirmPhoto(
    @Param('id') lotId: string,
    @Param('photoId') photoId: string,
    @Req() req: AuthenticatedRequest,
  ) {
    return this.lotPhotos.confirm(req.identity!, lotId, photoId);
  }

  @Delete(':id/photos/:photoId')
  @Roles('producer', 'supplier')
  @ApiOperation({
    summary: 'Eliminar foto del lote',
    description: 'Elimina lógicamente la foto y solicita borrar el objeto privado.',
  })
  @ApiParam({ name: 'id', schema: { type: 'string', format: 'uuid' } })
  @ApiParam({ name: 'photoId', schema: { type: 'string', format: 'uuid' } })
  @ApiZodResponse(200, z.object({ status: z.literal('deleted') }), { status: 'deleted' })
  @ApiErrorResponses(401, 403, 404, 409, 503)
  async deletePhoto(
    @Param('id') lotId: string,
    @Param('photoId') photoId: string,
    @Req() req: AuthenticatedRequest,
  ) {
    await this.lotPhotos.delete(req.identity!, lotId, photoId);
    return { status: 'deleted' as const };
  }

  @Patch(':id/photos/order')
  @Roles('producer', 'supplier')
  @ApiOperation({
    summary: 'Ordenar fotos del lote',
    description: 'Define el orden completo de las fotos listas del lote.',
  })
  @ApiParam({ name: 'id', schema: { type: 'string', format: 'uuid' } })
  @ApiZodBody(reorderPhotosSchema, { photoIds: ['0190f47a-8b45-7cc2-9a1e-123456789abc'] })
  @ApiZodResponse(200, z.object({ status: z.literal('ordered') }), { status: 'ordered' })
  @ApiErrorResponses(400, 401, 403, 404, 409)
  async reorderPhotos(
    @Param('id') lotId: string,
    @Body() body: unknown,
    @Req() req: AuthenticatedRequest,
  ) {
    const { photoIds } = reorderPhotosSchema.parse(body);
    await this.lotPhotos.reorder(req.identity!, lotId, photoIds);
    return { status: 'ordered' as const };
  }
  @Patch(':id')
  @Roles('producer', 'supplier')
  @ApiOperation({
    summary: 'Actualizar lote',
    description: 'Actualiza campos del lote usando control optimista mediante version.',
  })
  @ApiParam({
    name: 'id',
    schema: { type: 'string', format: 'uuid' },
    example: '018f47a2-8b45-7cc2-9a1e-123456789abe',
  })
  @ApiZodBody(updateLotRequestSchema, {
    version: 1,
    unitPrice: 3200,
  })
  @ApiErrorResponses(400, 401, 403, 404, 409)
  async update(@Param('id') id: string, @Body() body: unknown, @Req() req: AuthenticatedRequest) {
    const { version, ...input } = updateLotRequestSchema.parse(body);
    const patch = {
      ...(input.productId !== undefined ? { productId: input.productId } : {}),
      ...(input.quantityMilli !== undefined ? { quantityMilli: BigInt(input.quantityMilli) } : {}),
      ...(input.unit !== undefined ? { unit: input.unit } : {}),
      ...(input.unitPrice !== undefined ? { unitPrice: BigInt(input.unitPrice) } : {}),
      ...(input.qualityGrade !== undefined ? { qualityGrade: input.qualityGrade } : {}),
      ...(input.availableFrom !== undefined
        ? { availableFrom: new Date(input.availableFrom) }
        : {}),
      ...(input.availableUntil !== undefined
        ? { availableUntil: new Date(input.availableUntil) }
        : {}),
      ...(input.locationLat !== undefined ? { locationLat: input.locationLat } : {}),
      ...(input.locationLng !== undefined ? { locationLng: input.locationLng } : {}),
    };
    return this.toResponse(
      await this.catalog.updateLot(req.identity!, id, version, patch),
      req.identity!.sub,
    );
  }

  @Delete(':id')
  @Roles('producer', 'supplier')
  @ApiOperation({
    summary: 'Eliminar borrador de lote',
    description:
      'Elimina lógicamente solo un lote en borrador, marca sus fotos como borradas y publica un tombstone para sync. Para lotes publicados usa cancelar.',
  })
  @ApiParam({ name: 'id', schema: { type: 'string', format: 'uuid' } })
  @ApiZodBody(lotVersionSchema, { version: 1 })
  @ApiErrorResponses(400, 401, 403, 404, 409)
  async deleteLot(
    @Param('id') id: string,
    @Body() body: unknown,
    @Req() request: AuthenticatedRequest,
  ) {
    const { version } = lotVersionSchema.parse(body);
    const deleted = await this.deleteDraft.execute(request.identity!, id, version);
    return { id: deleted.id, version: deleted.version, status: 'deleted' as const };
  }
  @Post(':id/publish')
  @Roles('producer', 'supplier')
  @ApiOperation({
    summary: 'Publicar lote',
    description: 'Publica el borrador si version coincide con la versión actual.',
  })
  @ApiParam({
    name: 'id',
    schema: { type: 'string', format: 'uuid' },
    example: '018f47a2-8b45-7cc2-9a1e-123456789abe',
  })
  @ApiErrorResponses(400, 401, 403, 404, 409)
  async publish(@Param('id') id: string, @Body() body: unknown, @Req() req: AuthenticatedRequest) {
    const version = this.parseVersion(body);
    return this.toResponse(
      await this.catalog.publishLot(req.identity!, id, version),
      req.identity!.sub,
    );
  }
  @Post(':id/cancel')
  @Roles('producer', 'supplier')
  @ApiOperation({
    summary: 'Cancelar lote',
    description: 'Cancela el lote cuando la transición de estado y version son válidas.',
  })
  @ApiParam({
    name: 'id',
    schema: { type: 'string', format: 'uuid' },
    example: '018f47a2-8b45-7cc2-9a1e-123456789abe',
  })
  @ApiErrorResponses(400, 401, 403, 404, 409)
  async cancel(@Param('id') id: string, @Body() body: unknown, @Req() req: AuthenticatedRequest) {
    const version = this.parseVersion(body);
    return this.toResponse(
      await this.catalog.cancelLot(req.identity!, id, version),
      req.identity!.sub,
    );
  }

  private parseVersion(body: unknown): number {
    return lotVersionSchema.parse(body).version;
  }
  private async toResponse(
    lot:
      | Awaited<ReturnType<CatalogService['getLot']>>
      | Awaited<ReturnType<CatalogService['createLot']>>,
    viewerId: string,
    distanceKm?: number,
    includeAllPhotos = false,
    availableOverride?: bigint,
  ) {
    const availableQuantityMilli =
      availableOverride ??
      (await this.catalog.getLotQuote(lot.id).then((quote) => quote.availableQuantityMilli));
    const lotWithAvailability = {
      ...lot,
      ...(availableQuantityMilli !== undefined ? { availableQuantityMilli } : {}),
    };
    const [provider] = await this.providers
      .getProviderPublicSummaries([lot.providerId])
      .then((map) => [map.get(lot.providerId)]);
    if (!provider)
      throw new DomainError('Perfil público del proveedor no encontrado.', 'not_found');
    const photos = await this.lotPhotos.photosForLots(
      [lot.id],
      includeAllPhotos ? new Set([lot.id]) : new Set(),
    );
    return {
      ...serializeLotForViewer(lotWithAvailability, provider, viewerId, distanceKm),
      photos: photos.get(lot.id) ?? [],
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
