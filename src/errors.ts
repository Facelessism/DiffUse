export type ExitCode = 0 | 2 | 3 | 4;

export const EXIT_OK = 0;
export const EXIT_USAGE = 2;
export const EXIT_GIT = 3;
export const EXIT_ANALYSIS = 4;

export class DiffUseError extends Error {
  readonly exitCode: ExitCode;

  constructor(message: string, exitCode: ExitCode) {
    super(message);
    this.name = "DiffUseError";
    this.exitCode = exitCode;
  }
}

export const usageError = (message: string): DiffUseError => new DiffUseError(message, EXIT_USAGE);
export const gitError = (message: string): DiffUseError => new DiffUseError(message, EXIT_GIT);
export const analysisError = (message: string): DiffUseError => new DiffUseError(message, EXIT_ANALYSIS);
