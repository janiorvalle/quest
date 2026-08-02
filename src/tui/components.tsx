import { stringWidth } from "bun";
import type {
  QuestLogChainRef,
  QuestLogDetail,
  QuestLogEventEntry,
  QuestLogEvidenceEntry,
  QuestLogItem,
  QuestLogSessionAttribution,
} from "../services/quest-log-model";
import { DENSE_THEME, type QuestTheme } from "./theme";
import { useQuestTheme } from "./theme-context";

export interface HeaderCounts {
  readonly active: number;
  readonly blocked: number;
  readonly complete: number;
  readonly ready: number;
  readonly review: number;
  readonly total: number;
}

const graphemeSegmenter = new Intl.Segmenter(undefined, { granularity: "grapheme" });
const ELLIPSIS = "…";

function graphemes(value: string): readonly string[] {
  return Array.from(graphemeSegmenter.segment(value), (part) => part.segment);
}

function firstGrapheme(value: string): string {
  return graphemes(value)[0] ?? "";
}

function takeDisplayWidth(value: string, width: number): string {
  if (width <= 0) {
    return "";
  }
  let used = 0;
  let result = "";
  for (const grapheme of graphemes(value)) {
    const nextWidth = stringWidth(grapheme);
    if (used + nextWidth > width) {
      break;
    }
    result += grapheme;
    used += nextWidth;
  }
  return result;
}

function fit(value: string, width: number): string {
  if (width <= 0) {
    return "";
  }
  if (stringWidth(value) <= width) {
    return value;
  }
  if (width === stringWidth(ELLIPSIS)) {
    return ELLIPSIS;
  }
  return `${takeDisplayWidth(value, width - stringWidth(ELLIPSIS))}${ELLIPSIS}`;
}

function pad(value: string, width: number, align: "left" | "right" = "left"): string {
  const fitted = fit(value, width);
  const padding = " ".repeat(Math.max(0, width - stringWidth(fitted)));
  return align === "right" ? `${padding}${fitted}` : `${fitted}${padding}`;
}

export function HorizontalRule({ width }: { readonly width: number }) {
  const theme = useQuestTheme();
  return (
    <box style={{ height: 1, overflow: "hidden", width: "100%" }}>
      <text fg={theme.palette.borderIdle}>
        {theme.glyphs.ruleHorizontal.repeat(Math.max(1, width))}
      </text>
    </box>
  );
}

function Counts({ counts, compact }: { readonly counts: HeaderCounts; readonly compact: boolean }) {
  const theme = useQuestTheme();
  if (compact) {
    return (
      <text>
        <span fg={theme.palette.textPrimary}>
          <strong>{counts.total}</strong>
        </span>
        <span fg={theme.palette.textMuted}>q</span>
        {counts.complete === 0 ? null : (
          <span
            fg={theme.status.complete.color}
          >{` ${counts.complete}${theme.glyphs.chainComplete}`}</span>
        )}
        {counts.ready === 0 ? null : (
          <span fg={theme.status.ready.color}>{` ${counts.ready}${theme.glyphs.watching}`}</span>
        )}
      </text>
    );
  }
  return (
    <text>
      <span fg={theme.palette.textPrimary}>
        <strong>{counts.total}</strong>
      </span>
      <span fg={theme.palette.textMuted}> quests</span>
      {counts.complete === 0 ? null : (
        <span
          fg={theme.status.complete.color}
        >{`  ${counts.complete} ${theme.glyphs.chainComplete}`}</span>
      )}
      {counts.ready === 0 ? null : (
        <span fg={theme.status.ready.color}>{`  ${counts.ready} ready`}</span>
      )}
      {counts.active === 0 ? null : (
        <span fg={theme.palette.textMuted}>{`  ${counts.active} active`}</span>
      )}
      {counts.review === 0 ? null : (
        <span fg={theme.status.turned_in.color}>{`  ${counts.review} review`}</span>
      )}
      {counts.blocked === 0 ? null : (
        <span fg={theme.status.open.color}>{`  ${counts.blocked} ${theme.glyphs.blocked}`}</span>
      )}
    </text>
  );
}

function headerContext(theme: QuestTheme, label: string, value: string) {
  return (
    <span>
      <span fg={theme.palette.textMuted}>{` · ${label} `}</span>
      <span fg={theme.palette.textPrimary}>{value}</span>
    </span>
  );
}

export function AppHeader({
  branch,
  counts,
  identity,
  repo,
  width,
}: {
  readonly branch: string | undefined;
  readonly counts: HeaderCounts;
  readonly identity: string | undefined;
  readonly repo: string;
  readonly width: number;
}) {
  const theme = useQuestTheme();
  const compact = width < 110;
  return (
    <box
      style={{
        alignItems: "center",
        flexDirection: "row",
        height: 1,
        justifyContent: "space-between",
        overflow: "hidden",
        paddingLeft: 1,
        paddingRight: 1,
        width: "100%",
      }}
    >
      <text>
        <span fg={theme.palette.accent}>
          <strong>{theme.labels.appTitle}</strong>
        </span>
        {headerContext(theme, "repo", fit(repo, compact ? 18 : 28))}
        {branch === undefined
          ? null
          : headerContext(theme, "branch", fit(branch, compact ? 18 : 28))}
        {identity === undefined
          ? null
          : headerContext(theme, "identity", fit(identity, compact ? 18 : 28))}
      </text>
      <Counts compact={compact} counts={counts} />
    </box>
  );
}

export interface AreaTab {
  readonly count: number;
  readonly key: string;
  readonly label: string;
}

export function TabsRow({
  activeIndex,
  scope,
  tabs,
  width,
}: {
  readonly activeIndex: number;
  readonly scope: string;
  readonly tabs: readonly AreaTab[];
  readonly width: number;
}) {
  const theme = useQuestTheme();
  const hint = `tab · scope: ${scope}`;
  return (
    <box
      style={{
        alignItems: "center",
        flexDirection: "row",
        height: 1,
        justifyContent: "space-between",
        overflow: "hidden",
        paddingLeft: 1,
        paddingRight: 1,
        width: "100%",
      }}
    >
      <box style={{ flexDirection: "row", flexGrow: 1, flexShrink: 1, overflow: "hidden" }}>
        {tabs.map((tab, index) => {
          const active = index === activeIndex;
          return (
            <box
              key={tab.key}
              style={{
                backgroundColor: active ? theme.palette.surface : theme.palette.background,
                height: 1,
                marginRight: 1,
                paddingLeft: 1,
                paddingRight: 1,
              }}
            >
              <text>
                <span fg={active ? theme.palette.accent : theme.palette.textMuted}>
                  {active ? <strong>{tab.label}</strong> : tab.label}
                </span>
                <span
                  fg={active ? theme.palette.textMuted : theme.palette.textDim}
                >{` ${tab.count}`}</span>
              </text>
            </box>
          );
        })}
      </box>
      <box style={{ flexShrink: 0, paddingLeft: 1 }}>
        <text fg={theme.palette.textDim}>{fit(hint, Math.max(1, width - 2))}</text>
      </box>
    </box>
  );
}

function listHeader(showKind: boolean, showAssignee: boolean): string {
  return [
    pad("ID", 5, "right"),
    pad("STATUS", 13),
    ...(showKind ? [pad("KIND", 7)] : []),
    pad("PRI", 4),
    ...(showAssignee ? [pad("ASSIGNEE", 16)] : []),
    "TITLE",
  ].join(" ");
}

function rowText(
  theme: QuestTheme,
  item: QuestLogItem,
  titleWidth: number,
  showKind: boolean,
  showAssignee: boolean,
  selected: boolean,
) {
  const status = theme.status[item.status];
  const muted = selected ? theme.palette.selectionInk : theme.palette.textMuted;
  const primary = selected ? theme.palette.selectionInk : theme.palette.textPrimary;
  const statusColor = selected ? theme.palette.selectionInk : status.color;
  const title = `${item.blocked ? `${theme.glyphs.blocked} ` : ""}${item.title}`;
  return (
    <span>
      <span fg={muted}>{`${pad(String(item.id), 5, "right")} `}</span>
      <span fg={statusColor}>{`${pad(status.label, 13)} `}</span>
      {showKind ? <span fg={muted}>{`${pad(item.kind, 7)} `}</span> : null}
      <span fg={selected || item.priority !== 1 ? muted : theme.status.open.color}>
        {`${pad(`${theme.glyphs.priority}${item.priority}`, 4)} `}
      </span>
      {showAssignee ? <span fg={muted}>{`${pad(item.assignee ?? "—", 16)} `}</span> : null}
      <span fg={item.blocked && !selected ? theme.status.open.color : primary}>
        {fit(title, titleWidth)}
      </span>
    </span>
  );
}

export function QuestListPane({
  height,
  hiddenDoneCount,
  items,
  loading,
  paneWidth,
  selectedIndex,
  terminalWidth,
  totalCount,
}: {
  readonly height: number;
  readonly hiddenDoneCount: number;
  readonly items: readonly QuestLogItem[];
  readonly loading: boolean;
  readonly paneWidth: number;
  readonly selectedIndex: number;
  readonly terminalWidth: number;
  readonly totalCount: number;
}) {
  const theme = useQuestTheme();
  const showAssignee = terminalWidth >= 100;
  const showKind = terminalWidth >= 90;
  const titleWidth = Math.max(
    8,
    paneWidth - 5 - 1 - 13 - 1 - (showKind ? 8 : 0) - 4 - 1 - (showAssignee ? 17 : 0),
  );
  const rowCapacity = Math.max(1, height - 3);
  const start = Math.max(0, Math.min(selectedIndex - rowCapacity + 1, items.length - rowCapacity));
  const visible = items.slice(start, start + rowCapacity);
  const scrollPosition = items.length === 0 ? 0 : Math.round((start / items.length) * 12);
  const scrollExtent =
    items.length === 0 ? 12 : Math.max(1, Math.round((visible.length / items.length) * 12));
  return (
    <box style={{ flexDirection: "column", height: "100%", overflow: "hidden", width: "100%" }}>
      <text fg={theme.palette.sectionLabel}>
        <strong>{listHeader(showKind, showAssignee)}</strong>
      </text>
      <text fg={theme.palette.borderIdle}>
        {theme.glyphs.ruleHorizontal.repeat(Math.max(1, paneWidth))}
      </text>
      {visible.length === 0 ? (
        <text fg={theme.palette.textMuted}>
          {loading ? "loading quests…" : "no quests in this view"}
        </text>
      ) : (
        visible.map((item, index) => {
          const actualIndex = start + index;
          const selected = actualIndex === selectedIndex;
          return (
            <box
              key={item.id}
              style={{
                backgroundColor: selected
                  ? theme.palette.selection
                  : index % 2 === 1
                    ? theme.palette.stripe
                    : theme.palette.background,
                height: 1,
                overflow: "hidden",
                width: "100%",
              }}
            >
              {selected ? (
                <text fg={theme.palette.selectionInk}>
                  <strong>{rowText(theme, item, titleWidth, showKind, showAssignee, true)}</strong>
                </text>
              ) : (
                <text>{rowText(theme, item, titleWidth, showKind, showAssignee, false)}</text>
              )}
            </box>
          );
        })
      )}
      <box style={{ flexGrow: 1 }} />
      <text fg={theme.palette.textDim}>
        {`↑↓ move · ${items.length} of ${totalCount} shown${hiddenDoneCount === 0 ? "" : ` · ${hiddenDoneCount} done hidden (d)`}  ${theme.glyphs.scrollbarTrack.repeat(scrollPosition)}${theme.glyphs.scrollbarFull.repeat(scrollExtent)}${theme.glyphs.scrollbarTrack.repeat(Math.max(0, 12 - scrollPosition - scrollExtent))}`}
      </text>
    </box>
  );
}

function detailTime(timestamp: string): string {
  return timestamp.length >= 16 ? timestamp.slice(11, 16) : timestamp;
}

export function sessionAttributionText(
  attribution: QuestLogSessionAttribution | null,
): string | null {
  if (attribution === null) {
    return null;
  }
  const values = [
    attribution.guild === undefined ? null : `guild ${attribution.guild}`,
    attribution.model ?? null,
    attribution.effort ?? null,
  ].filter((value): value is string => value !== null);
  return values.length === 0 ? null : values.join(" · ");
}

const DETAIL_HEADER_ROWS = 6;
const DETAIL_FOOTER_ROWS = 1;
const FILE_LABEL = "files       ";
const FILE_INDENT = " ".repeat(FILE_LABEL.length);

function appendEllipsis(value: string, width: number): string {
  if (width <= 0) {
    return "";
  }
  const trimmed = value.trimEnd();
  if (stringWidth(trimmed) + stringWidth(ELLIPSIS) <= width) {
    return `${trimmed}${ELLIPSIS}`;
  }
  return `${takeDisplayWidth(trimmed, width - stringWidth(ELLIPSIS))}${ELLIPSIS}`;
}

function appendLongWord(lines: string[], word: string, width: number): string {
  let remaining = word;
  while (stringWidth(remaining) > width) {
    const chunk = takeDisplayWidth(remaining, width);
    if (chunk === "") {
      const oversized = firstGrapheme(remaining);
      if (oversized === "") {
        break;
      }
      lines.push(stringWidth(oversized) > width ? ELLIPSIS : oversized);
      remaining = remaining.slice(oversized.length);
      continue;
    }
    lines.push(chunk);
    remaining = remaining.slice(chunk.length);
  }
  return remaining;
}

function appendWrappedWord(lines: string[], current: string, word: string, width: number): string {
  if (stringWidth(word) > width) {
    if (current !== "") {
      lines.push(current);
    }
    return appendLongWord(lines, word, width);
  }
  const candidate = current === "" ? word : `${current} ${word}`;
  if (stringWidth(candidate) > width) {
    lines.push(current);
    return word;
  }
  return candidate;
}

function wrapParagraph(paragraph: string, width: number): readonly string[] {
  const words = paragraph
    .trim()
    .split(/\s+/)
    .filter((word) => word !== "");
  if (words.length === 0) {
    return [""];
  }

  const lines: string[] = [];
  let current = "";
  for (const word of words) {
    current = appendWrappedWord(lines, current, word, width);
  }
  if (current !== "") {
    lines.push(current);
  }
  return lines;
}

export function wrapText(value: string, width: number): readonly string[] {
  if (width <= 0) {
    return [];
  }
  return value
    .replaceAll("\r\n", "\n")
    .split("\n")
    .flatMap((paragraph) => wrapParagraph(paragraph, width));
}

function truncateWrappedLines(
  lines: readonly string[],
  limit: number,
  width: number,
): readonly string[] {
  if (limit <= 0) {
    return [];
  }
  if (lines.length <= limit) {
    return lines;
  }
  const visible = lines.slice(0, limit);
  const last = visible[visible.length - 1];
  if (last === undefined) {
    return [];
  }
  visible[visible.length - 1] = appendEllipsis(last, width);
  return visible;
}

interface DetailTextLine {
  readonly key: string;
  readonly text: string;
}

function keyedTextLines(lines: readonly string[], prefix: string): readonly DetailTextLine[] {
  return lines.map((text, index) => ({ key: `${prefix}:${index}`, text }));
}

function wrapPath(path: string, firstWidth: number, continuationWidth: number): readonly string[] {
  const lines: string[] = [];
  let remaining = path;
  let width = Math.max(1, firstWidth);
  while (stringWidth(remaining) > width) {
    const candidate = takeDisplayWidth(remaining, width);
    if (candidate === "") {
      const oversized = firstGrapheme(remaining);
      if (oversized === "") {
        break;
      }
      lines.push(stringWidth(oversized) > width ? ELLIPSIS : oversized);
      remaining = remaining.slice(oversized.length);
      width = Math.max(1, continuationWidth);
      continue;
    }
    const slash = candidate.lastIndexOf("/");
    const line = slash >= 0 ? candidate.slice(0, slash + 1) : candidate;
    lines.push(line);
    remaining = remaining.slice(line.length);
    width = Math.max(1, continuationWidth);
  }
  lines.push(remaining);
  return lines;
}

interface DetailFileLine {
  readonly key: string;
  readonly text: string;
}

interface DetailFileBlock {
  readonly key: string;
  readonly lines: readonly DetailFileLine[];
  readonly width: number;
}

function fileBlocks(paths: readonly string[], width: number): readonly DetailFileBlock[] {
  const blocks: DetailFileBlock[] = [];
  const occurrences = new Map<string, number>();
  for (const [index, path] of paths.entries()) {
    const firstPrefix = index === 0 ? FILE_LABEL : FILE_INDENT;
    const wrapped = wrapPath(
      path,
      width - stringWidth(firstPrefix),
      width - stringWidth(FILE_INDENT),
    );
    const occurrence = occurrences.get(path) ?? 0;
    occurrences.set(path, occurrence + 1);
    const key = `file:${path}:${occurrence}`;
    blocks.push({
      key,
      lines: wrapped.map((line, lineIndex) => ({
        key: `${key}:${lineIndex}`,
        text: `${lineIndex === 0 ? firstPrefix : FILE_INDENT}${line}`,
      })),
      width,
    });
  }
  return blocks;
}

export interface DetailEvidenceRow {
  readonly entry: QuestLogEvidenceEntry | null;
  readonly kind: "entry" | "empty" | "loading" | "marker";
}

function detailEvidenceRows(detail: QuestLogDetail | null): readonly DetailEvidenceRow[] {
  if (detail === null) {
    return [{ entry: null, kind: "loading" }];
  }
  if (detail.evidence.length === 0) {
    return [{ entry: null, kind: "empty" }];
  }
  return detail.evidence.map((entry) => ({ entry, kind: "entry" }));
}

export interface DetailChainRow {
  readonly body: string;
  readonly continuation: boolean;
  readonly itemId: number | null;
  readonly kind: "relation" | "duplicate" | "marker";
  readonly key: string;
  readonly ref: QuestLogChainRef | null;
  readonly suffix: string | null;
}

interface DetailChainBlock {
  readonly bodyWidth: number;
  readonly rows: readonly DetailChainRow[];
}

function relationChainBlock(
  theme: QuestTheme,
  ref: QuestLogChainRef,
  suffix: string,
  width: number,
): DetailChainBlock {
  const prefixWidth = stringWidth(`${ref.id} ${theme.glyphs.arrow} `);
  const bodyWidth = Math.max(1, width - prefixWidth);
  const bodyLines = wrapText(`${ref.title} ${suffix}`, bodyWidth);
  return {
    bodyWidth,
    rows: bodyLines.map((body, index) => ({
      body,
      continuation: index > 0,
      itemId: null,
      kind: "relation",
      key: `relation:${ref.id}:${index}:${body}`,
      ref,
      suffix,
    })),
  };
}

function duplicateChainBlock(
  theme: QuestTheme,
  item: QuestLogItem,
  ref: QuestLogChainRef,
  width: number,
): DetailChainBlock {
  const prefixWidth = stringWidth(`${item.id} ${theme.labels.chainDuplicateOf} ${ref.id} `);
  const bodyWidth = Math.max(1, width - prefixWidth);
  const bodyLines = wrapText(ref.title, bodyWidth);
  return {
    bodyWidth,
    rows: bodyLines.map((body, index) => ({
      body,
      continuation: index > 0,
      itemId: item.id,
      kind: "duplicate",
      key: `duplicate:${item.id}:${ref.id}:${index}:${body}`,
      ref,
      suffix: null,
    })),
  };
}

function detailChainBlocks(
  theme: QuestTheme,
  item: QuestLogItem,
  detail: QuestLogDetail | null,
  width: number,
): readonly DetailChainBlock[] {
  if (detail === null) {
    return [];
  }
  return [
    ...detail.requires.map((ref) => relationChainBlock(theme, ref, "requires", width)),
    ...detail.requiredBy.map((ref) => relationChainBlock(theme, ref, "unlocks", width)),
    ...detail.duplicateOf.map((ref) => duplicateChainBlock(theme, item, ref, width)),
  ];
}

function flattenChainBlocks(blocks: readonly DetailChainBlock[]): readonly DetailChainRow[] {
  return blocks.flatMap((block) => block.rows);
}

export interface DetailActivityRow {
  readonly continuation: boolean;
  readonly detail: string | null;
  readonly detailWidth: number;
  readonly eventId: number | null;
  readonly indent: string;
  readonly kind: "event" | "marker" | "placeholder";
  readonly key: string;
  readonly label: string;
  readonly placeholder: string | null;
  readonly timestamp: string;
}

function activityPlaceholder(kind: "loading" | "empty"): DetailActivityRow {
  return {
    continuation: false,
    detail: null,
    detailWidth: 0,
    eventId: null,
    indent: "",
    kind: "placeholder",
    key: `placeholder-${kind}`,
    label: "",
    placeholder: kind === "loading" ? "loading detail…" : "no recorded events",
    timestamp: "",
  };
}

function activityBase(
  event: QuestLogEventEntry,
  width: number,
): {
  readonly label: string;
  readonly timestamp: string;
} {
  const timestamp = fit(detailTime(event.at), Math.max(1, width));
  const labelWidth = Math.max(0, width - stringWidth(timestamp) - 1);
  return {
    label: labelWidth === 0 ? "" : fit(`${event.action} ${event.actor}`, labelWidth),
    timestamp,
  };
}

function eventRows(
  event: QuestLogEventEntry,
  width: number,
  includeDetails: boolean,
): readonly DetailActivityRow[] {
  const base = activityBase(event, width);
  const baseWidth =
    stringWidth(base.timestamp) + (base.label === "" ? 0 : stringWidth(base.label) + 1);
  const detailWidth = Math.max(0, width - baseWidth - 3);
  const firstRow: DetailActivityRow = {
    continuation: false,
    detail: null,
    detailWidth: 0,
    eventId: event.id,
    indent: "",
    kind: "event",
    key: `event-${event.id}-0`,
    label: base.label,
    placeholder: null,
    timestamp: base.timestamp,
  };
  if (!includeDetails || event.detailSummary === null) {
    return [firstRow];
  }
  if (detailWidth > 0) {
    const detailLines = wrapText(event.detailSummary, detailWidth);
    return [
      {
        ...firstRow,
        detail: detailLines[0] ?? null,
        detailWidth,
      },
      ...detailLines.slice(1).map((detail, index) => ({
        ...firstRow,
        continuation: true,
        detail,
        detailWidth,
        indent: " ".repeat(baseWidth + 3),
        key: `event-${event.id}-${index + 1}`,
        label: "",
        timestamp: "",
      })),
    ];
  }

  const indentLength = Math.min(Math.max(0, width - 1), stringWidth(base.timestamp) + 1);
  const detailLines = wrapText(event.detailSummary, Math.max(1, width - indentLength));
  return [
    firstRow,
    ...detailLines.map((detail, index) => ({
      ...firstRow,
      continuation: true,
      detail,
      detailWidth: Math.max(1, width - indentLength),
      indent: " ".repeat(indentLength),
      key: `event-${event.id}-${index + 1}`,
      label: "",
      timestamp: "",
    })),
  ];
}

function detailActivityRows(
  detail: QuestLogDetail | null,
  width: number,
  includeDetails: boolean,
): readonly DetailActivityRow[] {
  if (detail === null) {
    return [activityPlaceholder("loading")];
  }
  if (detail.events.length === 0) {
    return [activityPlaceholder("empty")];
  }
  return detail.events.flatMap((event) => eventRows(event, width, includeDetails));
}

function detailRowsForLayout(
  showFiles: boolean,
  fileBlockRows: number,
  showEvidence: boolean,
  evidenceRows: number,
  showChain: boolean,
  chainRows: number,
  showActivity: boolean,
  activityRows: number,
  showFooter: boolean,
  descriptionBodyRows: number,
): number {
  return (
    DETAIL_HEADER_ROWS +
    (showFiles ? fileBlockRows : 0) +
    1 +
    descriptionBodyRows +
    (showEvidence ? 1 + evidenceRows : 0) +
    (showChain ? 1 + chainRows : 0) +
    (showActivity ? 1 + activityRows : 0) +
    (showFooter ? DETAIL_FOOTER_ROWS : 0)
  );
}

export interface DetailPaneLayout {
  readonly activityRows: readonly DetailActivityRow[];
  readonly chainRows: readonly DetailChainRow[];
  readonly descriptionBodyRows: number;
  readonly descriptionLines: readonly DetailTextLine[];
  readonly evidenceRows: readonly DetailEvidenceRow[];
  readonly fileBlocks: readonly DetailFileBlock[];
  readonly headerRows: number;
  readonly showActivity: boolean;
  readonly showChain: boolean;
  readonly showDescription: boolean;
  readonly showEvidence: boolean;
  readonly showFiles: boolean;
  readonly showFooter: boolean;
  readonly usedRows: number;
}

interface DetailLayoutState {
  currentActivityRows: readonly DetailActivityRow[];
  currentChainBlocks: readonly DetailChainBlock[];
  currentEvidenceRows: readonly DetailEvidenceRow[];
  currentFileBlocks: readonly DetailFileBlock[];
  showActivity: boolean;
  showChain: boolean;
  showEvidence: boolean;
  showFiles: boolean;
  showFooter: boolean;
}

function detailRowsForState(state: DetailLayoutState, descriptionBodyRows: number): number {
  return detailRowsForLayout(
    state.showFiles,
    state.currentFileBlocks.reduce((total, block) => total + block.lines.length, 0),
    state.showEvidence,
    state.currentEvidenceRows.length,
    state.showChain,
    state.currentChainBlocks.reduce((total, block) => total + block.rows.length, 0),
    state.showActivity,
    state.currentActivityRows.length,
    state.showFooter,
    descriptionBodyRows,
  );
}

function reduceFooter(state: DetailLayoutState): boolean {
  if (!state.showFooter) {
    return false;
  }
  state.showFooter = false;
  return true;
}

function reduceActivityDetails(
  state: DetailLayoutState,
  compactActivityRows: readonly DetailActivityRow[],
): boolean {
  if (state.currentActivityRows.length <= compactActivityRows.length) {
    return false;
  }
  for (let index = state.currentActivityRows.length - 1; index >= 0; index -= 1) {
    if (state.currentActivityRows[index]?.continuation !== true) {
      continue;
    }
    const previous = state.currentActivityRows[index - 1];
    if (previous === undefined) {
      return false;
    }
    state.currentActivityRows = [
      ...state.currentActivityRows.slice(0, index - 1),
      {
        ...previous,
        detail: appendEllipsis(previous.detail ?? "", previous.detailWidth),
      },
      ...state.currentActivityRows.slice(index + 1),
    ];
    return true;
  }
  return false;
}

function reduceActivityRows(state: DetailLayoutState): boolean {
  if (!state.showActivity || state.currentActivityRows.length <= 1) {
    return false;
  }
  state.currentActivityRows = state.currentActivityRows.slice(0, -1);
  return true;
}

function reduceActivitySection(state: DetailLayoutState): boolean {
  if (!state.showActivity) {
    return false;
  }
  state.showActivity = false;
  return true;
}

function reduceChainRows(state: DetailLayoutState): boolean {
  if (!state.showChain || state.currentChainBlocks.length === 0) {
    return false;
  }
  const lastIndex = state.currentChainBlocks.length - 1;
  const last = state.currentChainBlocks[lastIndex];
  if (last === undefined) {
    return false;
  }
  if (last.rows.length > 1) {
    const first = last.rows[0];
    if (first === undefined) {
      return false;
    }
    state.currentChainBlocks = [
      ...state.currentChainBlocks.slice(0, lastIndex),
      {
        ...last,
        rows: [
          {
            ...first,
            body: appendEllipsis(first.body, last.bodyWidth),
            key: `${first.key}:truncated`,
          },
        ],
      },
    ];
    return true;
  }
  if (state.currentChainBlocks.length <= 1) {
    return false;
  }
  state.currentChainBlocks = state.currentChainBlocks.slice(0, -1);
  return true;
}

function reduceChainSection(state: DetailLayoutState): boolean {
  if (!state.showChain) {
    return false;
  }
  state.showChain = false;
  return true;
}

function reduceEvidenceRows(state: DetailLayoutState): boolean {
  if (!state.showEvidence || state.currentEvidenceRows.length <= 1) {
    return false;
  }
  state.currentEvidenceRows = state.currentEvidenceRows.slice(0, -1);
  return true;
}

function reduceEvidenceSection(state: DetailLayoutState): boolean {
  if (!state.showEvidence) {
    return false;
  }
  state.showEvidence = false;
  return true;
}

function reduceFileBlocks(state: DetailLayoutState): boolean {
  if (!state.showFiles || state.currentFileBlocks.length === 0) {
    return false;
  }
  const lastIndex = state.currentFileBlocks.length - 1;
  const last = state.currentFileBlocks[lastIndex];
  if (last === undefined) {
    return false;
  }
  if (last.lines.length > 1) {
    const first = last.lines[0];
    if (first === undefined) {
      return false;
    }
    state.currentFileBlocks = [
      ...state.currentFileBlocks.slice(0, lastIndex),
      {
        ...last,
        lines: [
          { ...first, key: `${first.key}:truncated`, text: fit(`${first.text}…`, last.width) },
        ],
      },
    ];
    return true;
  }
  if (state.currentFileBlocks.length <= 1) {
    return false;
  }
  state.currentFileBlocks = state.currentFileBlocks.slice(0, -1);
  return true;
}

function reduceFileSection(state: DetailLayoutState): boolean {
  if (!state.showFiles) {
    return false;
  }
  state.showFiles = false;
  return true;
}

function reduceDetailLayout(
  state: DetailLayoutState,
  compactActivityRows: readonly DetailActivityRow[],
  descriptionRows: number,
  rowBudget: number,
): void {
  const reductions: readonly (() => boolean)[] = [
    () => reduceFooter(state),
    () => reduceActivityDetails(state, compactActivityRows),
    () => reduceChainRows(state),
    () => reduceChainSection(state),
    () => reduceEvidenceRows(state),
    () => reduceEvidenceSection(state),
    () => reduceFileBlocks(state),
    () => reduceFileSection(state),
    () => reduceActivityRows(state),
    () => reduceActivitySection(state),
  ];
  let reductionIndex = 0;
  while (
    detailRowsForState(state, descriptionRows) > rowBudget &&
    reductionIndex < reductions.length
  ) {
    if (!reductions[reductionIndex]?.()) {
      reductionIndex += 1;
    }
  }
}

export function buildDetailLayout(
  item: QuestLogItem,
  detail: QuestLogDetail | null,
  paneWidth: number,
  rows: number,
  theme: QuestTheme = DENSE_THEME,
): DetailPaneLayout {
  const rowBudget = Math.max(1, Math.floor(rows));
  const width = Math.max(1, Math.floor(paneWidth) - 2);
  const description = wrapText(item.description || "—", width);
  const headerRows = Math.min(DETAIL_HEADER_ROWS, rowBudget);
  if (rowBudget < DETAIL_HEADER_ROWS + 2) {
    const showDescription = rowBudget > headerRows;
    const descriptionBodyRows = Math.max(0, rowBudget - headerRows - (showDescription ? 1 : 0));
    return {
      activityRows: [],
      chainRows: [],
      descriptionBodyRows,
      descriptionLines: keyedTextLines(
        truncateWrappedLines(description, descriptionBodyRows, width),
        "description",
      ),
      evidenceRows: [],
      fileBlocks: [],
      headerRows,
      showActivity: false,
      showChain: false,
      showDescription,
      showEvidence: false,
      showFiles: false,
      showFooter: false,
      usedRows: headerRows + (showDescription ? 1 + descriptionBodyRows : 0),
    };
  }
  const naturalFileBlocks = fileBlocks(item.predictedFiles, width);
  const naturalEvidenceRows = detailEvidenceRows(detail);
  const naturalChainBlocks = detailChainBlocks(theme, item, detail, width);
  const fullActivityRows = detailActivityRows(detail, width, true);
  const compactActivityRows = detailActivityRows(detail, width, false);

  const state: DetailLayoutState = {
    currentActivityRows: fullActivityRows,
    currentChainBlocks: naturalChainBlocks,
    currentEvidenceRows: naturalEvidenceRows,
    currentFileBlocks: naturalFileBlocks,
    showActivity: true,
    showChain: naturalChainBlocks.length > 0,
    showEvidence: true,
    showFiles: naturalFileBlocks.length > 0,
    showFooter: true,
  };
  reduceDetailLayout(state, compactActivityRows, description.length, rowBudget);

  const staticRows = detailRowsForState(state, 0);
  const descriptionBodyRows = Math.min(description.length, Math.max(1, rowBudget - staticRows));
  const descriptionLines = keyedTextLines(
    truncateWrappedLines(description, descriptionBodyRows, width),
    "description",
  );
  const usedRows = detailRowsForState(state, descriptionBodyRows);
  return {
    activityRows: state.showActivity ? state.currentActivityRows : [],
    chainRows: state.showChain ? flattenChainBlocks(state.currentChainBlocks) : [],
    descriptionBodyRows,
    descriptionLines,
    evidenceRows: state.showEvidence ? state.currentEvidenceRows : [],
    fileBlocks: state.showFiles ? state.currentFileBlocks : [],
    headerRows,
    showActivity: state.showActivity,
    showChain: state.showChain,
    showDescription: true,
    showEvidence: state.showEvidence,
    showFiles: state.showFiles,
    showFooter: state.showFooter,
    usedRows,
  };
}

function DetailEvidence({
  rows,
  width,
}: {
  readonly rows: readonly DetailEvidenceRow[];
  readonly width: number;
}) {
  const theme = useQuestTheme();
  return (
    <box style={{ flexDirection: "column", width: "100%" }}>
      {rows.map((row) => {
        if (row.kind === "loading") {
          return (
            <text fg={theme.palette.textDim} key="loading" wrapMode="none">
              {fit("loading detail…", width)}
            </text>
          );
        }
        if (row.kind === "empty") {
          return (
            <text fg={theme.palette.textDim} key="empty" wrapMode="none">
              {fit(theme.labels.evidenceEmpty, width)}
            </text>
          );
        }
        if (row.kind === "marker") {
          return (
            <text fg={theme.palette.textDim} key="marker" wrapMode="none">
              {fit("…", width)}
            </text>
          );
        }
        const evidence = row.entry;
        if (evidence === null) {
          return null;
        }
        const complete = evidence.stage === "fix" || evidence.stage === "verify";
        const glyph = complete ? theme.glyphs.evidenceComplete : theme.glyphs.evidencePending;
        const prefix = `${glyph} `;
        return (
          <text key={evidence.id} wrapMode="none">
            <span fg={complete ? theme.status.complete.color : theme.palette.warn}>{prefix}</span>
            <span fg={theme.palette.textPrimary}>
              {fit(
                `${evidence.filename} ${evidence.stage} · ${evidence.actor}`,
                Math.max(0, width - stringWidth(prefix)),
              )}
            </span>
          </text>
        );
      })}
    </box>
  );
}

function DetailActivityRowView({
  row,
  theme,
}: {
  readonly row: DetailActivityRow;
  readonly theme: QuestTheme;
}) {
  if (row.kind === "placeholder" || row.kind === "marker") {
    return <text fg={theme.palette.textDim}>{row.placeholder}</text>;
  }
  return (
    <text wrapMode="none">
      {row.continuation ? (
        <span fg={theme.palette.textDim}>{row.indent}</span>
      ) : (
        <>
          <span fg={theme.palette.textDim}>{row.timestamp}</span>
          <span fg={theme.palette.textSecondary}>{row.label === "" ? "" : ` ${row.label}`}</span>
        </>
      )}
      {row.detail === null ? null : (
        <span fg={theme.palette.textDim}>{row.continuation ? row.detail : ` · ${row.detail}`}</span>
      )}
    </text>
  );
}

function DetailActivity({ rows }: { readonly rows: readonly DetailActivityRow[] }) {
  const theme = useQuestTheme();
  return (
    <box style={{ flexDirection: "column", width: "100%" }}>
      <text fg={theme.palette.sectionLabel}>
        <strong>{theme.labels.activity}</strong>
      </text>
      {rows.map((row) => (
        <DetailActivityRowView key={row.key} row={row} theme={theme} />
      ))}
    </box>
  );
}

function DetailChainRowView({
  item,
  row,
  theme,
}: {
  readonly item: QuestLogItem;
  readonly row: DetailChainRow;
  readonly theme: QuestTheme;
}) {
  if (row.kind === "marker") {
    return <text fg={theme.palette.textDim}>…</text>;
  }
  const ref = row.ref;
  if (ref === null) {
    return null;
  }
  if (row.continuation) {
    const prefixWidth =
      row.kind === "relation"
        ? stringWidth(`${ref.id} ${theme.glyphs.arrow} `)
        : stringWidth(`${item.id} ${theme.labels.chainDuplicateOf} ${ref.id} `);
    return (
      <text wrapMode="none">
        <span fg={theme.palette.textDim}>{" ".repeat(prefixWidth)}</span>
        <span fg={theme.palette.textDim}>{row.body}</span>
      </text>
    );
  }
  return row.kind === "relation" ? (
    <text wrapMode="none">
      <span fg={theme.status[ref.status].color}>{`${ref.id} `}</span>
      <span fg={theme.palette.textMuted}>{`${theme.glyphs.arrow} `}</span>
      <span fg={theme.palette.textDim}>{row.body}</span>
    </text>
  ) : (
    <text wrapMode="none">
      <span fg={theme.palette.textPrimary}>{`${item.id} `}</span>
      <span fg={theme.palette.textMuted}>{`${theme.labels.chainDuplicateOf} `}</span>
      <span fg={theme.status[ref.status].color}>{`${ref.id} `}</span>
      <span fg={theme.palette.textDim}>{row.body}</span>
    </text>
  );
}

function DetailHeader({
  detail,
  headerRows,
  item,
  paneWidth,
  status,
  theme,
}: {
  readonly detail: QuestLogDetail | null;
  readonly headerRows: number;
  readonly item: QuestLogItem;
  readonly paneWidth: number;
  readonly status: QuestTheme["status"][QuestLogItem["status"]];
  readonly theme: QuestTheme;
}) {
  const detailContentWidth = Math.max(1, paneWidth - 2);
  const attribution = sessionAttributionText(detail?.sessionAttribution ?? null);
  const assignee = `assignee    ${item.assignee ?? "—"}`;
  const assigneeWithAttribution = attribution === null ? assignee : `${assignee} · ${attribution}`;
  const titlePrefix = `quest ${item.id} · `;
  const statusPrefix = `${item.kind} · ${item.area ?? "unassigned"} · `;
  const statusSuffix = `${status.label} · ${theme.labels.statusPhrase[item.status]}`;
  const statusSuffixWidth = Math.min(detailContentWidth, stringWidth(statusSuffix));
  const statusPrefixWidth = Math.max(0, detailContentWidth - statusSuffixWidth);
  const rows = [
    <text key="title" wrapMode="none">
      <span fg={theme.palette.textMuted}>{titlePrefix}</span>
      <span fg={theme.palette.textPrimary}>
        <strong>
          {fit(item.title, Math.max(1, detailContentWidth - stringWidth(titlePrefix)))}
        </strong>
      </span>
    </text>,
    <text key="status" wrapMode="none">
      <span fg={theme.palette.textMuted}>{fit(statusPrefix, statusPrefixWidth)}</span>
      <span fg={status.color}>{fit(statusSuffix, statusSuffixWidth)}</span>
    </text>,
    <text fg={theme.palette.borderIdle} key="rule">
      {theme.glyphs.ruleHorizontal.repeat(Math.max(1, paneWidth - 2))}
    </text>,
    <text fg={theme.palette.textMuted} key="assignee" wrapMode="none">
      {fit(assigneeWithAttribution, detailContentWidth)}
    </text>,
    <text fg={theme.palette.textMuted} key="opened-by" wrapMode="none">
      {fit(`opened by   ${item.openedBy}`, detailContentWidth)}
    </text>,
    <text fg={theme.palette.accent} key="pr" wrapMode="none">
      {fit(`pr          ${item.pr ?? "—"}`, detailContentWidth)}
    </text>,
  ];
  return <>{rows.slice(0, headerRows)}</>;
}

export function DetailPane({
  detail,
  item,
  paneWidth,
  rows,
}: {
  readonly detail: QuestLogDetail | null;
  readonly item: QuestLogItem | undefined;
  readonly paneWidth: number;
  readonly rows: number;
}) {
  const theme = useQuestTheme();
  if (item === undefined) {
    return (
      <box
        style={{
          backgroundColor: theme.palette.surface,
          height: "100%",
          paddingLeft: 1,
          width: "100%",
        }}
      >
        <text fg={theme.palette.textMuted}>select a quest</text>
      </box>
    );
  }

  const status = theme.status[item.status];
  const layout = buildDetailLayout(item, detail, paneWidth, rows, theme);
  return (
    <box
      style={{
        backgroundColor: theme.palette.surface,
        flexDirection: "column",
        height: "100%",
        overflow: "hidden",
        paddingLeft: 1,
        paddingRight: 1,
        width: "100%",
      }}
    >
      <DetailHeader
        detail={detail}
        headerRows={layout.headerRows}
        item={item}
        paneWidth={paneWidth}
        status={status}
        theme={theme}
      />
      {layout.showFiles ? (
        <box style={{ flexDirection: "column", width: "100%" }}>
          {layout.fileBlocks.map((block) => (
            <box key={block.key} style={{ flexDirection: "column", width: "100%" }}>
              {block.lines.map((line) => (
                <text fg={theme.palette.textMuted} key={line.key} wrapMode="none">
                  {line.text}
                </text>
              ))}
            </box>
          ))}
        </box>
      ) : null}
      {layout.showDescription ? (
        <>
          <text fg={theme.palette.sectionLabel}>
            <strong>{theme.labels.description}</strong>
          </text>
          <box
            style={{
              flexDirection: "column",
              height: layout.descriptionBodyRows,
              overflow: "hidden",
              width: "100%",
            }}
          >
            {layout.descriptionLines.map((line) => (
              <text fg={theme.palette.textPrimary} key={line.key} wrapMode="none">
                {line.text}
              </text>
            ))}
          </box>
        </>
      ) : null}
      {layout.showEvidence ? (
        <box style={{ flexDirection: "column", width: "100%" }}>
          <text fg={theme.palette.sectionLabel}>
            <strong>{`${theme.labels.evidence} · ${detail?.evidence.length ?? 0}`}</strong>
          </text>
          <DetailEvidence rows={layout.evidenceRows} width={Math.max(1, paneWidth - 2)} />
        </box>
      ) : null}
      {layout.showChain ? (
        <box style={{ flexDirection: "column", width: "100%" }}>
          <text fg={theme.palette.sectionLabel}>
            <strong>{theme.labels.chain}</strong>
          </text>
          {layout.chainRows.map((row) => (
            <DetailChainRowView item={item} key={row.key} row={row} theme={theme} />
          ))}
        </box>
      ) : null}
      {layout.showActivity ? <DetailActivity rows={layout.activityRows} /> : null}
      {layout.showFooter ? (
        <text fg={theme.palette.textDim} wrapMode="none">
          {fit("E open evidence · p open PR · q quit", Math.max(1, paneWidth - 2))}
        </text>
      ) : null}
    </box>
  );
}

export function StatusRow({
  notice,
  pollIntervalMs,
  width,
}: {
  readonly notice: string;
  readonly pollIntervalMs: number;
  readonly width: number;
}) {
  const theme = useQuestTheme();
  return (
    <box
      style={{
        flexDirection: "row",
        height: 1,
        justifyContent: "space-between",
        overflow: "hidden",
        paddingLeft: 1,
        paddingRight: 1,
        width: "100%",
      }}
    >
      <text>
        <span fg={theme.status.complete.color}>{`${theme.glyphs.watching} watching`}</span>
        <span fg={theme.palette.textMuted}>{` · live · poll ${pollIntervalMs}ms`}</span>
        {notice === "Watching for quest changes" ? null : (
          <span
            fg={theme.palette.textSecondary}
          >{` · ${fit(notice, Math.max(1, width - 48))}`}</span>
        )}
      </text>
      <text fg={theme.palette.textMuted}>read-only</text>
    </box>
  );
}

export function FooterKeymap() {
  const theme = useQuestTheme();
  const actions = [
    ["tab", "areas"],
    ["r", "repo"],
    ["d", "done"],
    ["j/k", "move"],
    ["E", "evidence"],
    ["p", "pr"],
  ] as const;
  return (
    <box
      style={{
        flexDirection: "row",
        height: 1,
        justifyContent: "space-between",
        overflow: "hidden",
        paddingLeft: 1,
        paddingRight: 1,
        width: "100%",
      }}
    >
      <text>
        {actions.map(([key, label]) => (
          <span key={key}>
            <span fg={theme.palette.hint}>
              <strong>{key}</strong>
            </span>
            <span fg={theme.palette.textMuted}>{` ${label}  `}</span>
          </span>
        ))}
      </text>
      <text>
        <span fg={theme.palette.hint}>
          <strong>q</strong>
        </span>
        <span fg={theme.palette.textMuted}> quit</span>
      </text>
    </box>
  );
}

export function areaLabel(area: string | null | undefined): string {
  if (area === undefined) {
    return "all";
  }
  if (area === null) {
    return "unassigned";
  }
  return area === "all" || area === "unassigned" ? `${area} · area` : area;
}

export function areaTabKey(area: string | null | undefined): string {
  if (area === undefined) {
    return "all";
  }
  return area === null ? "unassigned" : `area:${area}`;
}
