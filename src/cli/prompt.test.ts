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
