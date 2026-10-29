// lib/errors.mjs — 统一的可诊断错误。错误码是接口的一部分，测试与 doctor 都依赖它。
// 约定：不要把「文件坏了」吞成「文件不存在」，也不要把权限错误吞成默认值。

export class PsmError extends Error {
  constructor(code, message, detail = {}) {
    super(message);
    this.name = 'PsmError';
    this.code = code;
    this.detail = detail && typeof detail === 'object' ? detail : {};
  }
}

export const CODES = {
  FILE_NOT_FOUND: 'FILE_NOT_FOUND',
  JSON_INVALID: 'JSON_INVALID',
  SCHEMA_INVALID: 'SCHEMA_INVALID',
  PERMISSION_DENIED: 'PERMISSION_DENIED',
  IO_ERROR: 'IO_ERROR',
  WRITE_FAILED: 'WRITE_FAILED',
  LOCK_BUSY: 'LOCK_BUSY',
  LOCK_STALE_UNKNOWN: 'LOCK_STALE_UNKNOWN',
  MIGRATION_REQUIRED: 'MIGRATION_REQUIRED',
  VERSION_UNSUPPORTED: 'VERSION_UNSUPPORTED',
  INVALID_ARGUMENT: 'INVALID_ARGUMENT',
  NOT_FOUND: 'NOT_FOUND',
  FORBIDDEN_SCOPE: 'FORBIDDEN_SCOPE',
  CONFLICT_UNRESOLVED: 'CONFLICT_UNRESOLVED',
  VALIDATION_FAILED: 'VALIDATION_FAILED',
  MODEL_UNAVAILABLE: 'MODEL_UNAVAILABLE',
  BACKUP_FAILED: 'BACKUP_FAILED',
  RESTORE_FAILED: 'RESTORE_FAILED',
  NO_STORE: 'NO_STORE',
};

export function fail(code, message, detail = {}) {
  throw new PsmError(code, message, detail);
}

export function isPsmError(err) {
  return Boolean(err && err.name === 'PsmError' && typeof err.code === 'string');
}

export function codeOf(err) {
  if (isPsmError(err)) return err.code;
  if (err && err.code === 'ENOENT') return CODES.FILE_NOT_FOUND;
  if (err && (err.code === 'EACCES' || err.code === 'EPERM')) return CODES.PERMISSION_DENIED;
  return 'ERROR';
}

// CLI 顶层把错误转成一行可操作文本；JSON 模式保留 code/detail。
export function toErrorShape(err) {
  return {
    error: true,
    code: codeOf(err),
    message: err && err.message ? err.message : String(err),
    detail: (err && err.detail) || {},
  };
}
