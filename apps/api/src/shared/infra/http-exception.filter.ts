import { ArgumentsHost, Catch, ExceptionFilter, HttpException, HttpStatus } from '@nestjs/common';
import type { Response } from 'express';
import { ZodError } from 'zod';
import { DomainError, RateLimitExceeded } from '../kernel/domain-error.js';

const domainStatus: Record<string, number> = {
  invalid_phone: HttpStatus.BAD_REQUEST,
  invalid_role: HttpStatus.FORBIDDEN,
  consent_required: HttpStatus.BAD_REQUEST,
  consent_version_mismatch: HttpStatus.CONFLICT,
  invalid_otp: HttpStatus.UNAUTHORIZED,
  otp_expired: HttpStatus.UNAUTHORIZED,
  otp_attempts_exceeded: HttpStatus.TOO_MANY_REQUESTS,
  session_invalid: HttpStatus.UNAUTHORIZED,
  session_expired: HttpStatus.UNAUTHORIZED,
  user_not_found: HttpStatus.NOT_FOUND,
  access_denied: HttpStatus.FORBIDDEN,
  rate_limited: HttpStatus.TOO_MANY_REQUESTS,
  forbidden: HttpStatus.FORBIDDEN,
  not_found: HttpStatus.NOT_FOUND,
  version_conflict: HttpStatus.CONFLICT,
  assignment_conflict: HttpStatus.CONFLICT,
  invalid_order_status: HttpStatus.CONFLICT,
  // Conflicts with the current state of the resource; the contract documents 409 for them.
  invalid_transition: HttpStatus.CONFLICT,
  role_not_changeable: HttpStatus.CONFLICT,
  same_role: HttpStatus.CONFLICT,
  own_account: HttpStatus.CONFLICT,
  staff_account: HttpStatus.CONFLICT,
  invalid_reason: HttpStatus.BAD_REQUEST,
  quote_expired: HttpStatus.CONFLICT,
  lot_unavailable: HttpStatus.CONFLICT,
  reservation_conflict: HttpStatus.CONFLICT,
  reservation_expired: HttpStatus.CONFLICT,
  lot_location_locked: HttpStatus.CONFLICT,
  rating_conflict: HttpStatus.CONFLICT,
  alert_conflict: HttpStatus.CONFLICT,
  alert_limit: HttpStatus.CONFLICT,
  mapping_conflict: HttpStatus.CONFLICT,
  invalid_cursor: HttpStatus.BAD_REQUEST,
  invalid_channel: HttpStatus.BAD_REQUEST,
  invalid_radius: HttpStatus.BAD_REQUEST,
  invalid_price: HttpStatus.BAD_REQUEST,
  verification_checks_incomplete: HttpStatus.CONFLICT,
  verification_cooldown: HttpStatus.CONFLICT,
  proof_upload_missing: HttpStatus.CONFLICT,
  settlement_issued: HttpStatus.CONFLICT,
  ledger_already_posted: HttpStatus.CONFLICT,
  dispute_not_releasable: HttpStatus.CONFLICT,
  carrier_unknown: HttpStatus.CONFLICT,
  proof_expired: HttpStatus.GONE,
  proof_size_invalid: HttpStatus.UNPROCESSABLE_ENTITY,
  proof_image_invalid: HttpStatus.UNPROCESSABLE_ENTITY,
  idempotency_conflict: HttpStatus.CONFLICT,
  idempotency_content_mismatch: HttpStatus.CONFLICT,
  duplicate_lot_line: HttpStatus.BAD_REQUEST,
  lock_timeout: HttpStatus.SERVICE_UNAVAILABLE,
  statement_timeout: HttpStatus.SERVICE_UNAVAILABLE,
  lot_has_active_reservations: HttpStatus.CONFLICT,
  insufficient_stock: HttpStatus.CONFLICT,
  pending_limit_reached: HttpStatus.CONFLICT,
  product_similar_exists: HttpStatus.CONFLICT,
  product_pending_review: HttpStatus.CONFLICT,
  photo_limit: HttpStatus.CONFLICT,
  photo_not_pending: HttpStatus.CONFLICT,
  photo_order_invalid: HttpStatus.CONFLICT,
  invalid_photo_id: HttpStatus.BAD_REQUEST,
  photo_expired: HttpStatus.GONE,
  photo_upload_missing: HttpStatus.CONFLICT,
  photo_size_invalid: HttpStatus.UNPROCESSABLE_ENTITY,
  photo_format_invalid: HttpStatus.UNPROCESSABLE_ENTITY,
  photo_dimensions_invalid: HttpStatus.UNPROCESSABLE_ENTITY,
  photo_image_invalid: HttpStatus.UNPROCESSABLE_ENTITY,
  storage_unavailable: HttpStatus.SERVICE_UNAVAILABLE,
};

@Catch()
export class HttpExceptionFilter implements ExceptionFilter {
  catch(exception: unknown, host: ArgumentsHost): void {
    const response = host.switchToHttp().getResponse<Response>();
    if (exception instanceof ZodError) {
      const issue = exception.issues.find((item) => {
        const params = (item as unknown as { params?: { code?: unknown } }).params;
        return typeof params?.code === 'string';
      });
      const code = (issue as unknown as { params?: { code?: unknown } } | undefined)?.params?.code;
      if (code === 'duplicate_lot_line') {
        response.status(HttpStatus.BAD_REQUEST).json({
          statusCode: HttpStatus.BAD_REQUEST,
          code,
          message: 'El pedido contiene líneas duplicadas del mismo lote.',
        });
        return;
      }
      response
        .status(HttpStatus.BAD_REQUEST)
        .json({ statusCode: 400, message: 'Solicitud inválida.' });
      return;
    }
    if (exception instanceof DomainError) {
      const status = domainStatus[exception.code] ?? HttpStatus.BAD_REQUEST;
      if (exception instanceof RateLimitExceeded)
        response.setHeader('Retry-After', String(exception.retryAfter));
      response.status(status).json({
        statusCode: status,
        code: exception.code,
        message: exception.message,
        ...(exception.details ? { details: exception.details } : {}),
        ...(Array.isArray(exception.details?.suggestions)
          ? { suggestions: exception.details.suggestions }
          : {}),
      });
      return;
    }
    if (exception instanceof HttpException) {
      const status = exception.getStatus();
      response.status(status).json({ statusCode: status, message: exception.message });
      return;
    }
    const parserStatus =
      typeof exception === 'object' && exception !== null && 'status' in exception
        ? Number((exception as { status: unknown }).status)
        : undefined;
    if (parserStatus && parserStatus >= 400 && parserStatus < 500) {
      response.status(parserStatus).json({
        statusCode: parserStatus,
        message: parserStatus === 413 ? 'Solicitud demasiado grande.' : 'Solicitud inválida.',
      });
      return;
    }
    response
      .status(HttpStatus.INTERNAL_SERVER_ERROR)
      .json({ statusCode: 500, message: 'Error interno.' });
  }
}
