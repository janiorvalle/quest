import { createInterface } from "node:readline/promises";
import type { Readable, Writable } from "node:stream";

export interface CliPrompter {
  ask(question: string): Promise<string>;
  askSecret?(question: string): Promise<string>;
}

export interface CreateCliPrompterOptions {
  readonly input?: Readable;
  readonly output?: Writable;
}

export function applySecretInput(answer: string, input: string): string {
  let next = answer;
  for (const character of input) {
    if (character === "\u0008" || character === "\u007f") {
      next = next.slice(0, -1);
    } else {
      next += character;
    }
  }
  return next;
}

export function createCliPrompter(options: CreateCliPrompterOptions = {}): CliPrompter {
  const input = options.input ?? process.stdin;
  const output = options.output ?? process.stderr;
  const ask = async (question: string): Promise<string> => {
    const terminal = createInterface({ input, output });
    try {
      return await terminal.question(question);
    } finally {
      terminal.close();
    }
  };
  return {
    ask,
    async askSecret(question) {
      if (
        input !== process.stdin ||
        process.stdin.isTTY !== true ||
        !("setRawMode" in input) ||
        typeof input.setRawMode !== "function"
      ) {
        return ask(question);
      }
      output.write(question);
      input.setRawMode(true);
      input.resume();
      return new Promise<string>((resolve) => {
        let answer = "";
        const onData = (chunk: Buffer | string): void => {
          const text = chunk.toString();
          if (text.includes("\u0003")) {
            input.off("data", onData);
            input.pause();
            input.setRawMode(false);
            output.write("\n");
            resolve("");
            return;
          }
          const end = text.search(/[\r\n]/u);
          answer = applySecretInput(answer, end >= 0 ? text.slice(0, end) : text);
          if (end >= 0) {
            input.off("data", onData);
            input.pause();
            input.setRawMode(false);
            output.write("\n");
            resolve(answer);
            return;
          }
        };
        input.on("data", onData);
      });
    },
  };
}
