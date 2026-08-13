export class AppError extends Error {
  constructor(
    message: string,
    readonly statusCode = 500,
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = new.target.name;
  }
}

export class ConfigurationError extends AppError {}

export class DatabaseUnavailableError extends AppError {
  constructor(message: string, options?: ErrorOptions) { super(message, 503, options); }
}

export class NotFoundError extends AppError {
  constructor(message: string) {
    super(message, 404);
  }
}

export class ValidationError extends AppError {
  constructor(message: string) {
    super(message, 400);
  }
}

export class ProviderUnavailableError extends AppError {
  constructor(message: string, options?: ErrorOptions) {
    super(message, 503, options);
  }
}

export function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
