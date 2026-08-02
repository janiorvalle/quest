import { expect, test } from "bun:test";

import { openedPrNotice, openPrWithNotice, parseHttpUrl, prOpenFailureNotice } from "./pr";

test("accepts only http and https PR URLs", () => {
  expect(parseHttpUrl("https://github.com/janiorvalle/quest/pull/52")).toBe(
    "https://github.com/janiorvalle/quest/pull/52",
  );
  expect(parseHttpUrl("http://localhost:3000/pull/52")).toBe("http://localhost:3000/pull/52");
  expect(parseHttpUrl("javascript:alert(1)")).toBeUndefined();
  expect(parseHttpUrl("/tmp/pr.txt")).toBeUndefined();
  expect(parseHttpUrl("")).toBeUndefined();
});

test("formats the successful PR browser notice", () => {
  expect(openedPrNotice("https://github.com/janiorvalle/quest/pull/52")).toBe(
    "Opened PR in browser: https://github.com/janiorvalle/quest/pull/52",
  );
});

test("sets an actionable notice when PR opening rejects", async () => {
  let notice = "unchanged";

  openPrWithNotice(
    async () => {
      throw new Error("default app is unavailable");
    },
    "https://github.com/janiorvalle/quest/pull/52",
    (message) => {
      notice = message;
    },
  );

  await Bun.sleep(0);

  expect(notice).toBe(
    "Could not open PR: default app is unavailable. Check your default app and try again.",
  );
});

test("formats non-Error opener failures for the notice line", () => {
  expect(prOpenFailureNotice("no default app")).toBe(
    "Could not open PR: no default app. Check your default app and try again.",
  );
});
