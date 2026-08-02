import { expect, test } from "bun:test";

import {
  evidenceOpenFailureNotice,
  openEvidenceWithNotice,
  openedEvidenceNotice,
} from "./evidence";

test("sets an actionable notice when evidence opening rejects", async () => {
  let notice = "unchanged";

  openEvidenceWithNotice(
    async () => {
      throw new Error("default app is unavailable");
    },
    72,
    (message) => {
      notice = message;
    },
  );

  await Bun.sleep(0);

  expect(notice).toBe(
    "Could not open evidence: default app is unavailable. Check your default app and try again.",
  );
});

test("names the evidence files in the success notice", () => {
  expect(openedEvidenceNotice(["0001-report.txt", "0002-frame.png"])).toBe(
    "Opened 2 evidence files: 0001-report.txt, 0002-frame.png",
  );
  expect(openedEvidenceNotice([])).toBe("No evidence files were opened");
});

test("formats non-Error opener failures for the notice line", () => {
  expect(evidenceOpenFailureNotice("no default app")).toBe(
    "Could not open evidence: no default app. Check your default app and try again.",
  );
});
