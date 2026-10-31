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
};

@Catch()
export class HttpExceptionFilter implements ExceptionFilter {
  catch(exception: unknown, host: ArgumentsHost): void {
    const response = host.switchToHttp().getResponse<Response>();
    if (exception instanceof ZodError) {
      response
        .status(HttpStatus.BAD_REQUEST)
        .json({ statusCode: 400, message: 'Solicitud inválida.' });
      return;
    }
    if (exception instanceof DomainError) {
      const status = domainStatus[exception.code] ?? HttpStatus.BAD_REQUEST;
      if (exception instanceof RateLimitExceeded)
        response.setHeader('Retry-After', String(exception.retryAfter));
      response
        .status(status)
        .json({ statusCode: status, code: exception.code, message: exception.message });
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
