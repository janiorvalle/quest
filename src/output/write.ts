import type { CliError, CliErrorLineWriter, ExitCode } from "./errors";
import { writeCliError } from "./errors";

export type CliTextWriter = (text: string) => void;

export interface CliOutputBoundary {
  readonly write: CliTextWriter;
  readonly writeError: (error: CliError) => ExitCode;
}

export interface CliOutputBoundaryOptions {
  readonly stdout?: CliTextWriter;
  readonly stderr?: CliErrorLineWriter;
}

const defaultTextWriter: CliTextWriter = (text) => {
  process.stdout.write(text);
};

export function createCliOutputBoundary(options: CliOutputBoundaryOptions = {}): CliOutputBoundary {
  const stdout = options.stdout ?? defaultTextWriter;
  const stderr = options.stderr;

  return {
    write: (text) => stdout(text),
    writeError: (error) =>
      stderr === undefined ? writeCliError(error) : writeCliError(error, stderr),
  };
}
