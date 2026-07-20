export class DialCacheError extends Error {
  constructor(message: string) {
    super(message);
    this.name = new.target.name;
  }
}

export class FallbackTimeoutError extends DialCacheError {
  readonly timeoutMs: number;
  readonly useCase: string;

  constructor(useCase: string, timeoutMs: number) {
    super(`DialCache fallback for use case "${useCase}" timed out after ${timeoutMs} ms`);
    this.useCase = useCase;
    this.timeoutMs = timeoutMs;
  }
}

export class UseCaseIsAlreadyRegisteredError extends DialCacheError {
  constructor(useCase: string) {
    super(`Use case already registered: ${useCase}`);
  }
}

export class UseCaseNameIsReservedError extends DialCacheError {
  constructor(useCase: string) {
    super(`Use case name is reserved: ${useCase}`);
  }
}
