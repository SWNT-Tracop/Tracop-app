import {
  Body,
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Inject,
  Param,
  ParseUUIDPipe,
  Post,
  Query,
  Req,
  Res,
  UseGuards,
} from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import {
  approveVerificationSchema,
  myReputationResponseSchema,
  ratingResponseSchema,
  submitRatingSchema,
  verificationQuerySchema,
  verificationReasonSchema,
  verificationRequestSchema,
  verificationResponseSchema,
} from '@tracop/contracts';
import { z } from 'zod';
import { AuthGuard, type AuthPrincipal } from '../../../../shared/auth/index.js';
import { ApiErrorResponses, ApiZodBody, ApiZodResponse } from '../../../../shared/infra/openapi.js';
import type { TrustService } from '../../application/trust-service.js';
import { TRUST_SERVICE } from '../../application/trust-tokens.js';
import type { RatingProps } from '../../domain/rating.js';
import type { VerificationProps } from '../../domain/verification.js';

type AuthenticatedRequest = { readonly identity: AuthPrincipal };

const serializeRating = (rating: RatingProps) => ({
  id: rating.id,
  ratee: rating.rateeKind,
  score: rating.score,
  comment: rating.hiddenAt ? null : rating.comment,
});

const serializeVerification = (verification: VerificationProps) => ({
  providerId: verification.providerId,
  status: verification.status,
  note: verification.note,
  checks: verification.checks,
  reason: verification.reason,
  requestedAt: verification.requestedAt?.toISOString() ?? null,
  reviewedAt: verification.reviewedAt?.toISOString() ?? null,
});

const id = '018f47a2-8b45-7cc2-9a1e-123456789abc';
const verificationExample = {
  providerId: id,
  status: 'pending',
  note: 'Finca en Ventaquemada',
  checks: null,
  reason: null,
  requestedAt: '2026-11-25T15:00:00.000Z',
  reviewedAt: null,
};

@ApiTags('trust')
@ApiBearerAuth()
@UseGuards(AuthGuard)
@Controller('trust')
export class TrustController {
  constructor(@Inject(TRUST_SERVICE) private readonly trust: TrustService) {}

  @Post('ratings')
  @ApiOperation({
    summary: 'Calificar al proveedor o al transportista de un pedido (comprador)',
    description:
      'Solo pedidos entregados con pago verificado, hasta `trust.rating_window_days` (7, ' +
      'PROVISIONAL) después de la entrega. Idempotente por `id`; repetir la calificación con otro ' +
      'contenido u otro id responde el mismo 409. Pedido ajeno o no elegible: 404.',
  })
  @ApiZodBody(submitRatingSchema, {
    id,
    orderId: id,
    ratee: 'provider',
    score: 5,
    comment: 'Muy buena papa',
  })
  @ApiZodResponse(201, ratingResponseSchema, {
    id,
    ratee: 'provider',
    score: 5,
    comment: 'Muy buena papa',
  })
  @ApiErrorResponses(400, 401, 403, 404, 409, 429)
  async submitRating(
    @Req() req: AuthenticatedRequest,
    @Body() body: unknown,
    @Res({ passthrough: true }) response: { status(code: number): unknown },
  ) {
    const input = submitRatingSchema.parse(body);
    const result = await this.trust.submitRating(req.identity, input);
    response.status(result.created ? HttpStatus.CREATED : HttpStatus.OK);
    return serializeRating(result.rating);
  }

  @Get('me')
  @ApiOperation({
    summary: 'Mi reputación (proveedor o transportista)',
    description:
      'Promedio con un decimal y comentarios solo desde `trust.min_ratings_visible` (3, ' +
      'PROVISIONAL) calificaciones; los comentarios van sin pedido ni fecha y en un orden que no ' +
      'revela cuándo se hicieron.',
  })
  @ApiZodResponse(200, myReputationResponseSchema, {
    rating: '4.3',
    ratingsCount: 3,
    comments: ['Muy buena papa'],
    verification: 'verified',
  })
  @ApiErrorResponses(401, 403)
  async me(@Req() req: AuthenticatedRequest) {
    return this.trust.myReputation(req.identity);
  }

  @Post('verification-requests')
  @ApiOperation({ summary: 'Solicitar la verificación (productor o proveedor)' })
  @ApiZodBody(verificationRequestSchema, { note: 'Finca en Ventaquemada' })
  @ApiZodResponse(201, verificationResponseSchema, verificationExample)
  @ApiErrorResponses(400, 401, 403, 409, 429)
  async requestVerification(@Req() req: AuthenticatedRequest, @Body() body: unknown) {
    const { note } = verificationRequestSchema.parse(body ?? {});
    return serializeVerification(await this.trust.requestVerification(req.identity, note));
  }

  @Get('staff/verifications')
  @ApiOperation({ summary: 'Solicitudes de verificación (operator, admin)' })
  @ApiZodResponse(200, z.object({ items: z.array(verificationResponseSchema) }), {
    items: [verificationExample],
  })
  @ApiErrorResponses(400, 401, 403)
  async listVerifications(@Req() req: AuthenticatedRequest, @Query() query: unknown) {
    const { status, limit } = verificationQuerySchema.parse(query);
    const items = await this.trust.listVerifications(req.identity, status, limit);
    return { items: items.map(serializeVerification) };
  }

  @Post('staff/verifications/:providerId/approve')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Aprobar una verificación (operator, admin)',
    description:
      'Exige las tres comprobaciones (`contact_confirmed`, `location_confirmed`, `reference_checked`); ' +
      'si falta alguna, 409 `verification_checks_incomplete`. Auditado.',
  })
  @ApiZodBody(approveVerificationSchema, {
    checks: { contact_confirmed: true, location_confirmed: true, reference_checked: true },
  })
  @ApiZodResponse(200, verificationResponseSchema, { ...verificationExample, status: 'verified' })
  @ApiErrorResponses(400, 401, 403, 404, 409)
  async approve(
    @Req() req: AuthenticatedRequest,
    @Param('providerId', ParseUUIDPipe) providerId: string,
    @Body() body: unknown,
  ) {
    const { checks } = approveVerificationSchema.parse(body);
    return serializeVerification(
      await this.trust.approveVerification(req.identity, providerId, checks),
    );
  }

  @Post('staff/verifications/:providerId/reject')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Rechazar una verificación con motivo (operator, admin)',
    description: 'El proveedor podrá volver a solicitarla tras `trust.verification_cooldown_days`.',
  })
  @ApiZodBody(verificationReasonSchema, { reason: 'No se pudo confirmar la ubicación.' })
  @ApiZodResponse(200, verificationResponseSchema, { ...verificationExample, status: 'rejected' })
  @ApiErrorResponses(400, 401, 403, 404, 409)
  async reject(
    @Req() req: AuthenticatedRequest,
    @Param('providerId', ParseUUIDPipe) providerId: string,
    @Body() body: unknown,
  ) {
    const { reason } = verificationReasonSchema.parse(body);
    return serializeVerification(
      await this.trust.rejectVerification(req.identity, providerId, reason),
    );
  }

  @Post('staff/verifications/:providerId/revoke')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Revocar una verificación con motivo (operator, admin)' })
  @ApiZodBody(verificationReasonSchema, { reason: 'Quejas repetidas confirmadas.' })
  @ApiZodResponse(200, verificationResponseSchema, { ...verificationExample, status: 'revoked' })
  @ApiErrorResponses(400, 401, 403, 404, 409)
  async revoke(
    @Req() req: AuthenticatedRequest,
    @Param('providerId', ParseUUIDPipe) providerId: string,
    @Body() body: unknown,
  ) {
    const { reason } = verificationReasonSchema.parse(body);
    return serializeVerification(
      await this.trust.revokeVerification(req.identity, providerId, reason),
    );
  }

  @Post('staff/ratings/:id/hide')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Ocultar el comentario de una calificación (operator, admin)',
    description: 'La puntuación se conserva y sigue contando. Auditado.',
  })
  @ApiZodResponse(200, ratingResponseSchema, { id, ratee: 'provider', score: 2, comment: null })
  @ApiErrorResponses(400, 401, 403, 404)
  async hide(@Req() req: AuthenticatedRequest, @Param('id', ParseUUIDPipe) ratingId: string) {
    return serializeRating(await this.trust.hideComment(req.identity, ratingId));
  }

  @Get('staff/subjects/:userId')
  @ApiOperation({
    summary: 'Reputación completa de un proveedor o transportista (operator, admin)',
    description:
      'Incluye las calificaciones con su pedido y fecha, la verificación y las métricas internas de ' +
      'entrega del transportista (entregas y a tiempo). Solo para el personal.',
  })
  @ApiErrorResponses(400, 401, 403)
  async subject(@Req() req: AuthenticatedRequest, @Param('userId', ParseUUIDPipe) userId: string) {
    const subject = await this.trust.subjectForStaff(req.identity, userId);
    return {
      reputation: subject.reputation,
      verification: subject.verification ? serializeVerification(subject.verification) : null,
      carrierDeliveries: subject.carrierDeliveries,
      ratings: subject.ratings.map((rating) => ({
        id: rating.id,
        orderId: rating.orderId,
        ratee: rating.rateeKind,
        score: rating.score,
        comment: rating.comment,
        hidden: rating.hiddenAt !== null,
        createdAt: rating.createdAt.toISOString(),
      })),
    };
  }
}
