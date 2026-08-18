import { expect, test } from "bun:test";

import { type Event, type QuestDump, STORE_SCHEMA_VERSION } from "../../schema";
import {
  assembleConvexDump,
  assembleConvexListPages,
  CONVEX_DUMP_PAGE_MAX_ITEMS,
  type ConvexDumpPage,
  createConvexRestorePages,
  decodeConvexListCursor,
  encodeConvexListCursor,
  parseConvexListPage,
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
  expect(pages.map((page) => page.page_index)).toEqual([0, 1]);
  const dumpPages: ConvexDumpPage[] = pages.map((page, index) => {
    if (page.section !== "events") {
      throw new Error(`expected an events page, received ${page.section}`);
    }
    return {
      section: "events",
      items: page.items,
      next_cursor: index === pages.length - 1 ? null : `page-${index + 1}`,
      event_high_water: source.events.length,
    };
  });
  expect(assembleConvexDump(dumpPages)).toEqual(source);
});

test("restore pages canonicalize item order before hashing and upload", () => {
  const pages = createConvexRestorePages(dump([event(2), event(1)]));

  expect(pages).toHaveLength(1);
  expect(pages[0]?.section).toBe("events");
  expect(pages[0]?.items.map((item) => ("id" in item ? item.id : 0))).toEqual([1, 2]);
});

test("restore pages split by serialized value size before item count", () => {
  const source = dump([event(1, "a".repeat(300_000)), event(2, "b".repeat(300_000))]);

  const pages = createConvexRestorePages(source);

  expect(pages).toHaveLength(2);
  expect(pages.every((page) => page.items.length === 1)).toBeTrue();
});

test("list cursors and pages preserve bounded snapshot state", () => {
  const cursor = {
    version: 1,
    mode: "federated",
    section: "fences",
    database_cursor: "next-fence",
    snapshot_generation: 42,
    fence_generation: 7,
    lease_cutoff: "2026-08-17T00:00:00.000Z",
    request_key: "null",
  } as const;
  expect(decodeConvexListCursor(encodeConvexListCursor(cursor))).toEqual(cursor);

  const page = parseConvexListPage({
    section: "fences",
    items: ["zeta", "alpha"],
    next_cursor: null,
    snapshot_generation: 42,
  });
  expect(assembleConvexListPages([page])).toEqual({
    chains: [],
    fencedRepositories: ["alpha", "zeta"],
    quests: [],
  });
});
