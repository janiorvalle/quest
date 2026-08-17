import { expect, test } from "bun:test";

import { type Event, type QuestDump, STORE_SCHEMA_VERSION } from "../../schema";
import {
  assembleConvexDump,
  CONVEX_DUMP_PAGE_MAX_ITEMS,
  type ConvexDumpPage,
  createConvexRestorePages,
} from "./pagination";

function event(id: number, payload = "small"): Event {
  return {
    id,
    quest_id: 1,
    at: "2026-08-17T00:00:00.000Z",
    actor: "pagination-test",
    action: "update",
    detail: { payload },
  };
}

function dump(events: readonly Event[]): QuestDump {
  return {
    schema_version: STORE_SCHEMA_VERSION,
    quests: [],
    evidence: [],
    chains: [],
    events: [...events],
  };
}

test("restore pages stay below the Convex array element cap", () => {
  const source = dump(
    Array.from({ length: CONVEX_DUMP_PAGE_MAX_ITEMS + 1 }, (_, index) => event(index + 1)),
  );

  const pages = createConvexRestorePages(source);

  expect(pages).toHaveLength(2);
  expect(pages.map((page) => page.items.length)).toEqual([CONVEX_DUMP_PAGE_MAX_ITEMS, 1]);
  const dumpPages: ConvexDumpPage[] = pages.map((page, index) => {
    if (page.section !== "events") {
      throw new Error(`expected an events page, received ${page.section}`);
    }
    return {
      section: "events",
      items: page.items,
      next_cursor: index === pages.length - 1 ? null : `page-${index + 1}`,
    };
  });
  expect(assembleConvexDump(dumpPages)).toEqual(source);
});

test("restore pages split by serialized value size before item count", () => {
  const source = dump([event(1, "a".repeat(300_000)), event(2, "b".repeat(300_000))]);

  const pages = createConvexRestorePages(source);

  expect(pages).toHaveLength(2);
  expect(pages.every((page) => page.items.length === 1)).toBeTrue();
});
