import { z } from "zod";

import { sanitizeSingleLineText } from "./text";

export const exitCodeSchema = z.union([z.literal(0), z.literal(1), z.literal(2)]);
export type ExitCode = z.infer<typeof exitCodeSchema>;

export const EXIT_SUCCESS = 0 satisfies ExitCode;
export const EXIT_DOMAIN_ERROR = 1 satisfies ExitCode;
export const EXIT_USAGE_ERROR = 2 satisfies ExitCode;

export const cliErrorSchema = z.strictObject({
  kind: z.enum(["domain", "usage"]),
  message: z.string().trim().min(1),
});
export type CliError = z.infer<typeof cliErrorSchema>;

const renderedCliErrorSchema = z.strictObject({
  exitCode: exitCodeSchema,
  line: z.string().regex(/^quest: (domain|usage): [^\r\n]+$/),
});
export type RenderedCliError = z.infer<typeof renderedCliErrorSchema>;
export type CliErrorLineWriter = (line: string) => void;

function exitCodeFor(kind: CliError["kind"]): ExitCode {
  switch (kind) {
    case "domain":
      return EXIT_DOMAIN_ERROR;
    case "usage":
      return EXIT_USAGE_ERROR;
  }
}

export function renderCliError(input: CliError): RenderedCliError {
  const error = cliErrorSchema.parse(input);
  const message = cliErrorSchema.shape.message.parse(
    sanitizeSingleLineText(error.message).replaceAll(/\s+/g, " "),
  );

  return renderedCliErrorSchema.parse({
    exitCode: exitCodeFor(error.kind),
    line: `quest: ${error.kind}: ${message}`,
  });
}

const defaultErrorLineWriter: CliErrorLineWriter = (line) => console.error(line);

export function writeCliError(
  input: CliError,
  writeLine: CliErrorLineWriter = defaultErrorLineWriter,
): ExitCode {
  const error = renderCliError(input);
  writeLine(error.line);
  return error.exitCode;
}
