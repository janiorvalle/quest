import { z } from "zod";

import {
  type Chain,
  chainSchema,
  type Event,
  type Evidence,
  eventSchema,
  evidenceSchema,
  type Quest,
  type QuestDump,
  questDumpSchema,
  questSchema,
  STORE_SCHEMA_VERSION,
} from "../../schema";

export const CONVEX_DUMP_PAGE_MAX_ITEMS = 1_024;
export const CONVEX_DUMP_PAGE_MAX_BYTES = 512 * 1_024;

export const convexDumpSectionSchema = z.enum(["quests", "evidence", "chains", "events"]);
export type ConvexDumpSection = z.infer<typeof convexDumpSectionSchema>;

export type ConvexDumpPage =
  | {
      readonly section: "quests";
      readonly items: readonly Quest[];
      readonly next_cursor: string | null;
    }
  | {
      readonly section: "evidence";
      readonly items: readonly Evidence[];
      readonly next_cursor: string | null;
    }
  | {
      readonly section: "chains";
      readonly items: readonly Chain[];
      readonly next_cursor: string | null;
    }
  | {
      readonly section: "events";
      readonly items: readonly Event[];
      readonly next_cursor: string | null;
    };

type WithoutNextCursor<T> = T extends unknown ? Omit<T, "next_cursor"> : never;
export type ConvexRestorePage = WithoutNextCursor<ConvexDumpPage>;

export interface ConvexDumpCursor {
  readonly version: 1;
  readonly section: ConvexDumpSection;
  readonly database_cursor: string | null;
  readonly event_high_water: number;
  readonly lease_cutoff: string;
  readonly raw: boolean;
  readonly fenced_repositories?: readonly string[];
}

const convexDumpCursorSchema = z.strictObject({
  version: z.literal(1),
  section: convexDumpSectionSchema,
  database_cursor: z.string().nullable(),
  event_high_water: z.int().nonnegative(),
  lease_cutoff: z.string(),
  raw: z.boolean(),
  fenced_repositories: z.array(z.string()).optional(),
});

export function encodeConvexDumpCursor(cursor: ConvexDumpCursor): string {
  return JSON.stringify(convexDumpCursorSchema.parse(cursor));
}

export function decodeConvexDumpCursor(cursor: string): ConvexDumpCursor {
  const parsed = convexDumpCursorSchema.parse(JSON.parse(cursor));
  return {
    version: parsed.version,
    section: parsed.section,
    database_cursor: parsed.database_cursor,
    event_high_water: parsed.event_high_water,
    lease_cutoff: parsed.lease_cutoff,
    raw: parsed.raw,
    ...(parsed.fenced_repositories === undefined
      ? {}
      : { fenced_repositories: parsed.fenced_repositories }),
  };
}

export function nextConvexDumpSection(section: ConvexDumpSection): ConvexDumpSection | undefined {
  const sections: readonly ConvexDumpSection[] = ["quests", "evidence", "chains", "events"];
  return sections[sections.indexOf(section) + 1];
}

export function parseConvexDumpPage(value: unknown): ConvexDumpPage {
  const envelope = z
    .object({
      section: convexDumpSectionSchema,
      items: z.array(z.unknown()),
      next_cursor: z.string().nullable(),
    })
    .parse(value);
  switch (envelope.section) {
    case "quests":
      return {
        section: "quests",
        items: z.array(questSchema).parse(envelope.items),
        next_cursor: envelope.next_cursor,
      };
    case "evidence":
      return {
        section: "evidence",
        items: z.array(evidenceSchema).parse(envelope.items),
        next_cursor: envelope.next_cursor,
      };
    case "chains":
      return {
        section: "chains",
        items: z.array(chainSchema).parse(envelope.items),
        next_cursor: envelope.next_cursor,
      };
    case "events":
      return {
        section: "events",
        items: z.array(eventSchema).parse(envelope.items),
        next_cursor: envelope.next_cursor,
      };
  }
}

export function assembleConvexDump(pages: readonly ConvexDumpPage[]): QuestDump {
  const dump: {
    schema_version: typeof STORE_SCHEMA_VERSION;
    quests: Quest[];
    evidence: Evidence[];
    chains: Chain[];
    events: Event[];
  } = {
    schema_version: STORE_SCHEMA_VERSION,
    quests: [],
    evidence: [],
    chains: [],
    events: [],
  };
  for (const page of pages) {
    switch (page.section) {
      case "quests":
        dump.quests.push(...page.items);
        break;
      case "evidence":
        dump.evidence.push(...page.items);
        break;
      case "chains":
        dump.chains.push(...page.items);
        break;
      case "events":
        dump.events.push(...page.items);
        break;
    }
  }
  return questDumpSchema.parse(dump);
}

function serializedBytes(value: unknown): number {
  return new TextEncoder().encode(JSON.stringify(value)).byteLength;
}

function sectionPages<T>(section: ConvexDumpSection, items: readonly T[]): ConvexRestorePage[] {
  const pages: ConvexRestorePage[] = [];
  let page: T[] = [];
  let pageBytes = 2;
  for (const item of items) {
    const itemBytes = serializedBytes(item) + (page.length === 0 ? 0 : 1);
    if (
      page.length > 0 &&
      (page.length >= CONVEX_DUMP_PAGE_MAX_ITEMS ||
        pageBytes + itemBytes > CONVEX_DUMP_PAGE_MAX_BYTES)
    ) {
      pages.push({ section, items: page } as ConvexRestorePage);
      page = [];
      pageBytes = 2;
    }
    page.push(item);
    pageBytes += itemBytes;
  }
  if (page.length > 0) {
    pages.push({ section, items: page } as ConvexRestorePage);
  }
  return pages;
}

export function createConvexRestorePages(dump: QuestDump): readonly ConvexRestorePage[] {
  const parsed = questDumpSchema.parse(dump);
  return [
    ...sectionPages("quests", parsed.quests),
    ...sectionPages("evidence", parsed.evidence),
    ...sectionPages("chains", parsed.chains),
    ...sectionPages("events", parsed.events),
  ];
}
