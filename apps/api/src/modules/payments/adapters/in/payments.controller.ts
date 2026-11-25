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
  disputePaymentSchema,
  initiatePaymentSchema,
  ledgerResponseSchema,
  markSettlementPaidSchema,
  paymentListResponseSchema,
  paymentResponseSchema,
  paymentReviewQuerySchema,
  paymentVersionSchema,
  proofUploadResponseSchema,
  rejectPaymentSchema,
  resolveDisputeSchema,
  settlementListResponseSchema,
  settlementQuerySchema,
  settlementResponseSchema,
} from '@tracop/contracts';
import { AuthGuard, type AuthPrincipal } from '../../../../shared/auth/index.js';
import { ApiErrorResponses, ApiZodBody, ApiZodResponse } from '../../../../shared/infra/openapi.js';
import { PAYMENTS_SERVICE } from '../../application/payments-tokens.js';
import type { PaymentsService, PaymentView } from '../../application/payments-service.js';
import type { SettlementProps } from '../../domain/settlement.js';
import type { StoredLedgerEntry } from '../../ports/payments-ports.js';

type AuthenticatedRequest = { readonly identity: AuthPrincipal };

const iso = (value: Date | null): string | null => (value ? value.toISOString() : null);

export const serializePayment = ({ payment, proofUrl }: PaymentView) => ({
  id: payment.id,
  orderId: payment.orderId,
  method: payment.method,
  status: payment.status,
  version: payment.version,
  subtotal: payment.subtotal.toString(),
  freight: payment.freight.toString(),
  commission: payment.commission.toString(),
  total: payment.total.toString(),
  providerNet: payment.providerNet.toString(),
  proofUploadedAt: iso(payment.proofUploadedAt),
  proofUrl,
  reviewedAt: iso(payment.reviewedAt),
  rejectionReason: payment.rejectionReason,
  heldAt: iso(payment.heldAt),
  disputeReason: payment.disputeReason,
  createdAt: payment.createdAt.toISOString(),
  updatedAt: payment.updatedAt.toISOString(),
});

const serializeSettlement = (settlement: SettlementProps) => ({
  id: settlement.id,
  paymentId: settlement.paymentId,
  orderId: settlement.orderId,
  beneficiaryId: settlement.beneficiaryId,
  beneficiaryKind: settlement.beneficiaryKind,
  amount: settlement.amount.toString(),
  status: settlement.status,
  issuedAt: settlement.issuedAt.toISOString(),
  paidAt: iso(settlement.paidAt),
  reference: settlement.reference,
  version: settlement.version,
});

const serializeLedgerEntry = (entry: StoredLedgerEntry) => ({
  transactionId: entry.transactionId,
  kind: entry.kind,
  account: entry.account,
  debit: entry.debit.toString(),
  credit: entry.credit.toString(),
  createdAt: entry.createdAt.toISOString(),
});

const id = '018f47a2-8b45-7cc2-9a1e-123456789abc';
const paymentExample = {
  id,
  orderId: id,
  method: 'transfer',
  status: 'proof_uploaded',
  version: 3,
  subtotal: '100000',
  freight: '0',
  commission: '0',
  total: '100000',
  providerNet: '100000',
  proofUploadedAt: '2026-11-24T15:00:00.000Z',
  proofUrl: 'https://storage.example/proof-firmado',
  reviewedAt: null,
  rejectionReason: null,
  heldAt: null,
  disputeReason: null,
  createdAt: '2026-11-24T14:00:00.000Z',
  updatedAt: '2026-11-24T15:00:00.000Z',
};
const settlementExample = {
  id,
  paymentId: id,
  orderId: id,
  beneficiaryId: id,
  beneficiaryKind: 'producer',
  amount: '95000',
  status: 'issued',
  issuedAt: '2026-11-26T15:00:00.000Z',
  paidAt: null,
  reference: null,
  version: 1,
};

@ApiTags('payments')
@ApiBearerAuth()
@UseGuards(AuthGuard)
@Controller('orders')
export class OrderPaymentsController {
  constructor(@Inject(PAYMENTS_SERVICE) private readonly payments: PaymentsService) {}

  @Post(':orderId/payment')
  @ApiOperation({
    summary: 'Elegir el medio de pago de un pedido aceptado (comprador)',
    description:
      'Crea el pago `pending` y pasa el pedido a `payment_pending`. Idempotente por pedido: mientras ' +
      'el pedido tenga un pago abierto se devuelve ese mismo pago con 200.',
  })
  @ApiZodBody(initiatePaymentSchema, { id, method: 'transfer' })
  @ApiZodResponse(
    201,
    paymentResponseSchema,
    { ...paymentExample, status: 'pending' },
    'Pago creado.',
  )
  @ApiZodResponse(200, paymentResponseSchema, paymentExample, 'El pedido ya tenía un pago abierto.')
  @ApiErrorResponses(400, 401, 403, 404, 409, 503)
  async initiate(
    @Req() req: AuthenticatedRequest,
    @Param('orderId', ParseUUIDPipe) orderId: string,
    @Body() body: unknown,
    @Res({ passthrough: true }) response: { status(code: number): unknown },
  ) {
    const input = initiatePaymentSchema.parse(body);
    const result = await this.payments.initiate(req.identity, {
      orderId,
      paymentId: input.id,
      method: input.method,
    });
    response.status(result.created ? HttpStatus.CREATED : HttpStatus.OK);
    return serializePayment(result.view);
  }

  @Get(':orderId/payment')
  @ApiOperation({ summary: 'Pago más reciente de un pedido (comprador o personal)' })
  @ApiZodResponse(200, paymentResponseSchema, paymentExample)
  @ApiErrorResponses(400, 401, 404)
  async getForOrder(
    @Req() req: AuthenticatedRequest,
    @Param('orderId', ParseUUIDPipe) orderId: string,
  ) {
    return serializePayment(await this.payments.getForOrder(req.identity, orderId));
  }

  @Get(':orderId/ledger')
  @ApiOperation({ summary: 'Asientos contables de un pedido (finance, operator, admin)' })
  @ApiZodResponse(200, ledgerResponseSchema, { items: [] })
  @ApiErrorResponses(400, 401, 403)
  async ledger(@Req() req: AuthenticatedRequest, @Param('orderId', ParseUUIDPipe) orderId: string) {
    const entries = await this.payments.ledgerForOrder(req.identity, orderId);
    return { items: entries.map(serializeLedgerEntry) };
  }
}

@ApiTags('payments')
@ApiBearerAuth()
@UseGuards(AuthGuard)
@Controller('payments')
export class PaymentsController {
  constructor(@Inject(PAYMENTS_SERVICE) private readonly payments: PaymentsService) {}

  @Get('review')
  @ApiOperation({
    summary: 'Cola de revisión: comprobantes por verificar y disputas abiertas (personal)',
  })
  @ApiZodResponse(200, paymentListResponseSchema, { items: [paymentExample] })
  @ApiErrorResponses(400, 401, 403)
  async review(@Req() req: AuthenticatedRequest, @Query() query: unknown) {
    const { limit } = paymentReviewQuerySchema.parse(query);
    const items = await this.payments.listForReview(req.identity, limit);
    return { items: items.map((payment) => serializePayment({ payment, proofUrl: null })) };
  }

  @Get(':id')
  @ApiOperation({
    summary: 'Detalle del pago (comprador o personal)',
    description: '`proofUrl` es una URL firmada de corta duración: no la guardes ni la registres.',
  })
  @ApiZodResponse(200, paymentResponseSchema, paymentExample)
  @ApiErrorResponses(400, 401, 404)
  async get(@Req() req: AuthenticatedRequest, @Param('id', ParseUUIDPipe) paymentId: string) {
    return serializePayment(await this.payments.get(req.identity, paymentId));
  }

  @Post(':id/proof')
  @ApiOperation({
    summary: 'Preparar la carga del comprobante (comprador)',
    description:
      'Devuelve un POST prefirmado: sube la imagen (JPEG, PNG o WebP) directo al almacenamiento ' +
      'con todos los `fields` y después confirma.',
  })
  @ApiZodResponse(201, proofUploadResponseSchema, {
    uploadPolicy: {
      url: 'https://storage.example/bucket',
      fields: { key: 'payment-incoming/…' },
      expiresAt: '2026-11-24T15:15:00.000Z',
    },
  })
  @ApiErrorResponses(400, 401, 404, 409)
  async requestProofUpload(
    @Req() req: AuthenticatedRequest,
    @Param('id', ParseUUIDPipe) paymentId: string,
  ) {
    const policy = await this.payments.requestProofUpload(req.identity, paymentId);
    return {
      uploadPolicy: {
        url: policy.url,
        fields: policy.fields,
        expiresAt: policy.expiresAt.toISOString(),
      },
    };
  }

  @Post(':id/proof/confirm')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Confirmar el comprobante subido (comprador)',
    description:
      'Valida y re-codifica la imagen a WebP sin metadatos. El pago pasa a `proof_uploaded` y la ' +
      'reserva del pedido deja de vencer mientras se revisa.',
  })
  @ApiZodResponse(200, paymentResponseSchema, paymentExample)
  @ApiErrorResponses(400, 401, 404, 409, 410, 422, 503)
  async confirmProof(
    @Req() req: AuthenticatedRequest,
    @Param('id', ParseUUIDPipe) paymentId: string,
  ) {
    return serializePayment(await this.payments.confirmProof(req.identity, paymentId));
  }

  @Post(':id/verify')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Verificar el comprobante (finance, operator, admin)',
    description: 'El pedido queda `paid`, la reserva se consume y se registra el asiento.',
  })
  @ApiZodBody(paymentVersionSchema, { expectedVersion: 3 })
  @ApiZodResponse(200, paymentResponseSchema, { ...paymentExample, status: 'verified' })
  @ApiErrorResponses(400, 401, 403, 404, 409, 503)
  async verify(
    @Req() req: AuthenticatedRequest,
    @Param('id', ParseUUIDPipe) paymentId: string,
    @Body() body: unknown,
  ) {
    const { expectedVersion } = paymentVersionSchema.parse(body);
    return serializePayment(await this.payments.verify(req.identity, paymentId, expectedVersion));
  }

  @Post(':id/reject')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Rechazar el comprobante (finance, operator, admin)',
    description:
      'El pedido sigue `payment_pending`; su reserva vuelve a vencer tras ' +
      '`PAYMENT_REJECTION_GRACE_HOURS` (PROVISIONAL). El comprador puede iniciar otro pago.',
  })
  @ApiZodBody(rejectPaymentSchema, { expectedVersion: 3, reason: 'El comprobante es ilegible.' })
  @ApiZodResponse(200, paymentResponseSchema, { ...paymentExample, status: 'rejected' })
  @ApiErrorResponses(400, 401, 403, 404, 409, 503)
  async reject(
    @Req() req: AuthenticatedRequest,
    @Param('id', ParseUUIDPipe) paymentId: string,
    @Body() body: unknown,
  ) {
    const { expectedVersion, reason } = rejectPaymentSchema.parse(body);
    return serializePayment(
      await this.payments.reject(req.identity, paymentId, expectedVersion, reason),
    );
  }

  @Post(':id/dispute')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Abrir una disputa (comprador)',
    description: 'Solo sobre un pago verificado o retenido sin liquidaciones emitidas.',
  })
  @ApiZodBody(disputePaymentSchema, { expectedVersion: 5, reason: 'Llegó incompleto.' })
  @ApiZodResponse(200, paymentResponseSchema, { ...paymentExample, status: 'disputed' })
  @ApiErrorResponses(400, 401, 404, 409, 503)
  async dispute(
    @Req() req: AuthenticatedRequest,
    @Param('id', ParseUUIDPipe) paymentId: string,
    @Body() body: unknown,
  ) {
    const { expectedVersion, reason } = disputePaymentSchema.parse(body);
    return serializePayment(
      await this.payments.dispute(req.identity, paymentId, expectedVersion, reason),
    );
  }

  @Post(':id/dispute/resolve')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Resolver una disputa (finance, operator, admin)',
    description:
      '`release` devuelve a `held` un pago entregado para liquidarlo; `refund` registra la ' +
      'devolución (la transferencia se hace fuera de TRACOP). El pedido queda `closed`.',
  })
  @ApiZodBody(resolveDisputeSchema, {
    expectedVersion: 6,
    outcome: 'release',
    note: 'Se verificó la entrega.',
  })
  @ApiZodResponse(200, paymentResponseSchema, { ...paymentExample, status: 'held' })
  @ApiErrorResponses(400, 401, 403, 404, 409, 503)
  async resolveDispute(
    @Req() req: AuthenticatedRequest,
    @Param('id', ParseUUIDPipe) paymentId: string,
    @Body() body: unknown,
  ) {
    const input = resolveDisputeSchema.parse(body);
    return serializePayment(await this.payments.resolveDispute(req.identity, paymentId, input));
  }
}

@ApiTags('payments')
@ApiBearerAuth()
@UseGuards(AuthGuard)
@Controller('settlements')
export class SettlementsController {
  constructor(@Inject(PAYMENTS_SERVICE) private readonly payments: PaymentsService) {}

  @Get()
  @ApiOperation({
    summary: 'Liquidaciones',
    description: 'El personal ve todas; productores, proveedores y transportistas solo las suyas.',
  })
  @ApiZodResponse(200, settlementListResponseSchema, { items: [settlementExample] })
  @ApiErrorResponses(400, 401, 403)
  async list(@Req() req: AuthenticatedRequest, @Query() query: unknown) {
    const filter = settlementQuerySchema.parse(query);
    const items = await this.payments.listSettlements(req.identity, filter);
    return { items: items.map(serializeSettlement) };
  }

  @Post(':id/paid')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Marcar una liquidación como pagada (finance, operator, admin)',
    description: 'Al pagarse la última, el pago queda `settled` y el pedido `closed`.',
  })
  @ApiZodBody(markSettlementPaidSchema, { expectedVersion: 1, reference: 'TRX-0001' })
  @ApiZodResponse(200, settlementResponseSchema, { ...settlementExample, status: 'paid' })
  @ApiErrorResponses(400, 401, 403, 404, 409, 503)
  async markPaid(
    @Req() req: AuthenticatedRequest,
    @Param('id', ParseUUIDPipe) settlementId: string,
    @Body() body: unknown,
  ) {
    const input = markSettlementPaidSchema.parse(body);
    return serializeSettlement(
      await this.payments.markSettlementPaid(req.identity, settlementId, {
        expectedVersion: input.expectedVersion,
        reference: input.reference ?? null,
      }),
    );
  }
}
