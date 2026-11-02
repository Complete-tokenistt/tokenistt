/** Process exit codes: stable, so scripts and CI can branch on them. */
export const ExitCode = {
  Ok: 0,
  Error: 1,
  Usage: 2,
  Auth: 3,
  Network: 4,
  Policy: 5,
} as const;
export type ExitCode = (typeof ExitCode)[keyof typeof ExitCode];

/** An expected failure: printed as a message plus an actionable hint, never as a stack trace. */
export class CliError extends Error {
  constructor(
    message: string,
    public readonly exitCode: ExitCode = ExitCode.Error,
    public readonly hint?: string,
  ) {
    super(message);
    this.name = 'CliError';
  }
}

export class UsageError extends CliError {
  constructor(message: string, hint?: string) {
    super(message, ExitCode.Usage, hint);
    this.name = 'UsageError';
  }
}

export class AuthError extends CliError {
  constructor(message: string, hint = 'Run `tokenistt login`, or set TOKENISTT_TOKEN / TOKENISTT_API_KEY.') {
    super(message, ExitCode.Auth, hint);
    this.name = 'AuthError';
  }
}

export class NetworkError extends CliError {
  constructor(message: string, hint?: string) {
    super(message, ExitCode.Network, hint);
    this.name = 'NetworkError';
  }
}

/** The gateway answered with an error status. */
export class ApiError extends CliError {
  constructor(
    message: string,
    public readonly status: number,
    hint?: string,
  ) {
    super(message, status === 401 || status === 403 ? ExitCode.Auth : ExitCode.Error, hint);
    this.name = 'ApiError';
  }
}
