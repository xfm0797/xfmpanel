/**
 * 统一错误类型与错误信封。
 *
 * 对外只暴露稳定错误码 + 人类可读消息，堆栈与内部细节只写日志，
 * 避免把路径、命令、SQL 泄露给前端。
 */

import { ERROR_CODES } from '../../../shared/protocol.js';

export class HttpError extends Error {
  constructor(code, { message, details, field, cause } = {}) {
    const meta = ERROR_CODES[code] || ERROR_CODES.INTERNAL;
    super(message || meta.message);
    this.name = 'HttpError';
    this.code = ERROR_CODES[code] ? code : 'INTERNAL';
    this.status = meta.status;
    this.details = details;
    this.field = field;
    this.cause = cause;
    this.expose = true;
  }
}

export const errors = {
  authRequired: (m) => new HttpError('AUTH_REQUIRED', { message: m }),
  authFailed: (m) => new HttpError('AUTH_FAILED', { message: m }),
  forbidden: (m) => new HttpError('FORBIDDEN', { message: m }),
  notFound: (m) => new HttpError('NOT_FOUND', { message: m }),
  conflict: (m, details) => new HttpError('CONFLICT', { message: m, details }),
  validation: (m, field, details) =>
    new HttpError('VALIDATION_FAILED', { message: m, field, details }),
  rateLimited: (m) => new HttpError('RATE_LIMITED', { message: m }),
  internal: (m, cause) => new HttpError('INTERNAL', { message: m, cause }),
  agentUnavailable: (m) => new HttpError('AGENT_UNAVAILABLE', { message: m }),
  agentRejected: (m, details) => new HttpError('AGENT_REJECTED', { message: m, details }),
  taskConflict: (m) => new HttpError('TASK_CONFLICT', { message: m }),
  upstream: (m, details) => new HttpError('UPSTREAM_FAILED', { message: m, details }),
};

export function toHttpError(err) {
  if (err instanceof HttpError) return err;
  if (err?.name === 'ValidationError') {
    return new HttpError('VALIDATION_FAILED', {
      message: err.message,
      field: err.field,
      details: err.details,
    });
  }
  return new HttpError('INTERNAL', { message: '服务器内部错误', cause: err });
}

/** 统一响应体：成功 {ok:true,data}，失败 {ok:false,error:{code,message,field,details}} */
export function successBody(data, meta) {
  const body = { ok: true, data: data === undefined ? null : data };
  if (meta) body.meta = meta;
  return body;
}

export function errorBody(err, requestId) {
  const body = {
    ok: false,
    error: {
      code: err.code,
      message: err.message,
    },
  };
  if (err.field) body.error.field = err.field;
  if (err.details) body.error.details = err.details;
  if (requestId) body.requestId = requestId;
  return body;
}
