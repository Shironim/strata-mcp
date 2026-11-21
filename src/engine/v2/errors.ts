export type DomainErrorCode =
  | 'VALIDATION_ERROR'
  | 'NOT_FOUND'
  | 'STALE_SOURCE'
  | 'WORKSPACE_BOUNDARY_ERROR';

export class DomainError extends Error {
  constructor(
    public readonly code: DomainErrorCode,
    message: string,
    public readonly details?: Record<string, unknown>
  ) {
    super(message);
    this.name = 'DomainError';
  }
}

export class ValidationError extends DomainError {
  constructor(message: string, details?: Record<string, unknown>) {
    super('VALIDATION_ERROR', message, details);
    this.name = 'ValidationError';
  }
}

export class NotFoundError extends DomainError {
  constructor(message: string, details?: Record<string, unknown>) {
    super('NOT_FOUND', message, details);
    this.name = 'NotFoundError';
  }
}

export class StaleSourceError extends DomainError {
  constructor(message: string, details?: Record<string, unknown>) {
    super('STALE_SOURCE', message, details);
    this.name = 'StaleSourceError';
  }
}

export class WorkspaceBoundaryError extends DomainError {
  constructor(message: string, details?: Record<string, unknown>) {
    super('WORKSPACE_BOUNDARY_ERROR', message, details);
    this.name = 'WorkspaceBoundaryError';
  }
}
