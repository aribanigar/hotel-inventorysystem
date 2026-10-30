/**
 * Every failure the frontend may need to react to has an explicit, stable code.
 * The checkout UI switches on `code`, never on the human message.
 */
export type ErrorCode =
  | 'VALIDATION_ERROR'
  | 'UNAUTHORIZED'
  | 'FORBIDDEN' //         signed in, but this role may not do that
  | 'NOT_FOUND'
  | 'SOLD_OUT' //            room no longer available for one or more nights
  | 'PRICE_CHANGED' //       live price differs from what the user saw
  | 'RESTRICTED' //          stop-sell, min/max stay, closed to arrival/departure
  | 'INVENTORY_BUSY' //      row lock could not be taken in time; safe to retry
  | 'SUPPLIER_TIMEOUT' //    external B2B API did not answer in time
  | 'SUPPLIER_UNAVAILABLE' //external B2B API down / circuit open / bad response
  | 'HOLD_NOT_FOUND'
  | 'HOLD_EXPIRED'
  | 'PAYMENT_ERROR'
  | 'CONFLICT'
  | 'RATE_LIMITED'
  | 'INTERNAL_ERROR';

const STATUS: Record<ErrorCode, number> = {
  VALIDATION_ERROR: 400,
  UNAUTHORIZED: 401,
  FORBIDDEN: 403,
  NOT_FOUND: 404,
  SOLD_OUT: 409,
  PRICE_CHANGED: 409,
  RESTRICTED: 409,
  INVENTORY_BUSY: 409,
  SUPPLIER_TIMEOUT: 504,
  SUPPLIER_UNAVAILABLE: 503,
  HOLD_NOT_FOUND: 404,
  HOLD_EXPIRED: 410,
  PAYMENT_ERROR: 502,
  CONFLICT: 409,
  RATE_LIMITED: 429,
  INTERNAL_ERROR: 500,
};

export class AppError extends Error {
  readonly status: number;
  constructor(
    readonly code: ErrorCode,
    message: string,
    readonly details?: Record<string, unknown>,
    options?: { cause?: unknown },
  ) {
    super(message, options);
    this.name = 'AppError';
    this.status = STATUS[code];
  }

  /** Whether the client can simply retry the same request. */
  get retryable(): boolean {
    return this.code === 'INVENTORY_BUSY' || this.code === 'SUPPLIER_TIMEOUT' || this.code === 'SUPPLIER_UNAVAILABLE';
  }

  toJSON() {
    return { code: this.code, message: this.message, retryable: this.retryable, ...(this.details ? { details: this.details } : {}) };
  }
}

export const isAppError = (e: unknown): e is AppError => e instanceof AppError;
