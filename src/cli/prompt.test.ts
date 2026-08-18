import { expect, test } from "bun:test";
import { PassThrough } from "node:stream";

import { applySecretInput, createCliPrompter } from "./prompt";

test("interactive prompts use the injected diagnostic stream", async () => {
  const input = new PassThrough();
  const output = new PassThrough();
  let rendered = "";
  output.on("data", (chunk: Buffer) => {
    rendered += chunk.toString();
  });
  const answer = createCliPrompter({ input, output }).ask("Title: ");
  input.end("Lifecycle verbs\n");

  expect(await answer).toBe("Lifecycle verbs");
  expect(rendered).toBe("Title: ");
});

test("hidden prompt input supports backspace and delete editing", () => {
  expect(applySecretInput("s3cret", "\u0008\u0008et")).toBe("s3cret");
});

test("prompts reject instead of hanging when the input ends without an answer", async () => {
  const input = new PassThrough();
  const output = new PassThrough();
  output.resume();
  const answer = createCliPrompter({ input, output }).ask("Admin secret: ");
  input.end();

  expect(answer).rejects.toThrow(
    '[QUEST_PROMPT_UNANSWERED] the prompt "Admin secret:" needs an answer',
  );
});

test("prompts still accept answers piped through a non-interactive stream", async () => {
  const input = new PassThrough();
  const output = new PassThrough();
  output.resume();
  const answer = createCliPrompter({ input, output }).ask("Admin secret: ");
  input.end("piped-secret\n");

  expect(await answer).toBe("piped-secret");
});
