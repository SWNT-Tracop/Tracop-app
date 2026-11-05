import { applyDecorators } from '@nestjs/common';
import { ApiBody, ApiResponse } from '@nestjs/swagger';
import { z } from 'zod';

const errorSchema = {
  type: 'object',
  required: ['statusCode', 'message'],
  properties: {
    statusCode: { type: 'integer', example: 400 },
    code: { type: 'string', description: 'Código de dominio, si aplica.' },
    message: { type: 'string', example: 'Solicitud inválida.' },
  },
  additionalProperties: false,
};

const errorResponses: Record<number, { description: string; example: Record<string, unknown> }> = {
  400: {
    description: 'La solicitud no cumple el contrato o una regla de entrada.',
    example: { statusCode: 400, message: 'Solicitud inválida.' },
  },
  401: {
    description: 'Falta autenticación o las credenciales/sesión no son válidas.',
    example: { statusCode: 401, message: 'Autenticación requerida.' },
  },
  403: {
    description: 'El rol autenticado no está autorizado para esta operación.',
    example: { statusCode: 403, message: 'No tienes permiso para este recurso.' },
  },
  404: {
    description: 'El recurso solicitado no existe o no es visible para este usuario.',
    example: { statusCode: 404, code: 'not_found', message: 'Recurso no encontrado.' },
  },
  409: {
    description: 'La solicitud entra en conflicto con el estado actual del recurso.',
    example: { statusCode: 409, code: 'version_conflict', message: 'Conflicto de versión.' },
  },
  429: {
    description: 'Se excedió un límite de solicitudes. Puede incluir la cabecera Retry-After.',
    example: {
      statusCode: 429,
      code: 'rate_limited',
      message: 'Demasiadas solicitudes. Intenta nuevamente más tarde.',
    },
  },
  413: {
    description: 'El cuerpo excede el límite configurado.',
    example: { statusCode: 413, message: 'Solicitud demasiado grande.' },
  },
  410: {
    description: 'El recurso o la ventana temporal de la operación venció.',
    example: { statusCode: 410, code: 'photo_expired', message: 'La carga de la foto venció.' },
  },
  422: {
    description: 'La imagen no cumple el formato, tamaño o dimensiones permitidas.',
    example: { statusCode: 422, code: 'photo_format_invalid', message: 'La imagen no es válida.' },
  },
  503: {
    description: 'El servicio de almacenamiento no está disponible temporalmente.',
    example: {
      statusCode: 503,
      code: 'storage_unavailable',
      message: 'No se pudo procesar la imagen.',
    },
  },
  500: {
    description: 'Ocurrió un error interno.',
    example: { statusCode: 500, message: 'Error interno.' },
  },
};

export const openApiSchema = (schema: z.ZodType): Record<string, unknown> =>
  z.toJSONSchema(schema, { target: 'openapi-3.0', unrepresentable: 'any' });

export const ApiZodBody = (schema: z.ZodType, example: Record<string, unknown>) =>
  ApiBody({
    schema: openApiSchema(schema),
    examples: { synthetic: { summary: 'Ejemplo sintético', value: example } },
  });

export const ApiZodResponse = (
  status: number,
  schema: z.ZodType,
  example: unknown,
  description = 'Respuesta correcta.',
) => ApiResponse({ status, description, schema: openApiSchema(schema), example });

export const ApiErrorResponses = (...statusCodes: number[]) =>
  applyDecorators(
    ...statusCodes.map((status) => {
      const response = errorResponses[status];
      if (!response) throw new Error(`No OpenAPI error response is defined for HTTP ${status}.`);
      return ApiResponse({
        status,
        description: response.description,
        schema: {
          ...errorSchema,
          properties: {
            ...errorSchema.properties,
            statusCode: { type: 'integer', example: status },
          },
        },
        ...(status === 429
          ? {
              headers: {
                'Retry-After': {
                  description: 'Segundos hasta que se permita reintentar.',
                  schema: { type: 'integer' },
                },
              },
            }
          : {}),
        example: response.example,
      });
    }),
  );
