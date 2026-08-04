import { stringWidth } from "bun";
import type { PlanLaneCluster } from "../domain/plan";
import type {
  QuestLogChainRef,
  QuestLogDetail,
  QuestLogEventEntry,
  QuestLogEvidenceEntry,
  QuestLogItem,
  QuestLogSessionAttribution,
} from "../services/quest-log-model";
import { DENSE_THEME, type QuestTheme, questPriorityInk, questStatusText } from "./theme";
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
        <span
          fg={theme.status.open.color}
        >{`  ${counts.blocked} ${theme.glyphs.blockedFlag}`}</span>
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

function listHeader(showKind: boolean, showAssignee: boolean, statusWidth: number): string {
  return [
    pad("ID", 5, "right"),
    pad("STATUS", statusWidth),
    ...(showKind ? [pad("KIND", 7)] : []),
    pad("PRI", 4),
    ...(showAssignee ? [pad("ASSIGNEE", 16)] : []),
    "TITLE",
  ].join(" ");
}

function blockerIdsOf(item: QuestLogItem): readonly number[] {
  return item.blockerIds ?? (item.blockerId === undefined ? [] : [item.blockerId]);
}

export function blockedStatusText(theme: QuestTheme, item: QuestLogItem): string | null {
  if (item.computedState !== "blocked") {
    return null;
  }
  const blocked = `${theme.blockedStatus.glyph} ${theme.blockedStatus.label}`;
  const blockerIds = blockerIdsOf(item);
  const firstBlocker = blockerIds[0];
  if (firstBlocker === undefined) {
    return blocked;
  }
  const additionalBlockers = blockerIds.length - 1;
  return `${blocked} ${firstBlocker}${additionalBlockers > 0 ? ` +${additionalBlockers}` : ""}`;
}

export interface QuestLogLaneMarker {
  readonly edge: "end" | "start";
  readonly label: "same lane" | "shared files";
  readonly partnerIds: readonly number[];
}

function laneLabel(kind: PlanLaneCluster["kind"]): QuestLogLaneMarker["label"] {
  return kind === "shared_files" ? "shared files" : "same lane";
}

function lanePartnerIds(
  itemId: number,
  kind: PlanLaneCluster["kind"],
  clusters: readonly PlanLaneCluster[],
): readonly number[] {
  return [
    ...new Set(
      clusters
        .filter((cluster) => cluster.kind === kind && cluster.quest_ids.includes(itemId))
        .flatMap((cluster) => cluster.quest_ids.filter((questId) => questId !== itemId)),
    ),
  ].sort((left, right) => left - right);
}

function compactLanePartners(partnerIds: readonly number[]): string {
  const visible = partnerIds.slice(0, 2).join("+");
  const additional = partnerIds.length - 2;
  return visible === "" ? "" : `${visible}${additional > 0 ? ` +${additional}` : ""}`;
}

export function laneMarkerFor(
  index: number,
  items: readonly QuestLogItem[],
  clusters: readonly PlanLaneCluster[],
): QuestLogLaneMarker | null {
  const item = items[index];
  if (item === undefined || item.computedState === undefined) {
    return null;
  }
  const previous = items[index - 1];
  const next = items[index + 1];
  const previousCluster =
    previous === undefined
      ? undefined
      : clusters.find(
          (cluster) =>
            cluster.quest_ids.includes(previous.id) && cluster.quest_ids.includes(item.id),
        );
  if (previousCluster !== undefined) {
    return {
      edge: "end",
      label: laneLabel(previousCluster.kind),
      partnerIds: lanePartnerIds(item.id, previousCluster.kind, clusters),
    };
  }
  const nextCluster =
    next === undefined
      ? undefined
      : clusters.find(
          (cluster) => cluster.quest_ids.includes(item.id) && cluster.quest_ids.includes(next.id),
        );
  return nextCluster === undefined
    ? null
    : {
        edge: "start",
        label: laneLabel(nextCluster.kind),
        partnerIds: lanePartnerIds(item.id, nextCluster.kind, clusters),
      };
}

/** The status cell always leads with its glyph, rendered as bold as the cell allows. */
function statusCell(glyph: string, rest: string, color: string) {
  return (
    <span fg={color}>
      <strong>{glyph}</strong>
      {rest}
    </span>
  );
}

function blockedStatusCell(
  theme: QuestTheme,
  item: QuestLogItem,
  selected: boolean,
  statusWidth: number,
) {
  const dim = selected ? theme.palette.selectionInk : theme.palette.textDim;
  const { glyph, label } = theme.blockedStatus;
  const wordWidth = Math.max(1, statusWidth - stringWidth(glyph) - 1);
  const blockerIds = blockerIdsOf(item);
  const firstBlocker = blockerIds[0];
  const suffix = blockerIds.length > 1 ? ` +${blockerIds.length - 1}` : "";
  const blockerWidth = wordWidth - stringWidth(label) - 1 - stringWidth(suffix);
  if (firstBlocker === undefined || blockerWidth <= 0) {
    const crowded = firstBlocker === undefined ? label : `${label} ${firstBlocker}${suffix}`;
    return statusCell(glyph, ` ${pad(crowded, wordWidth)} `, dim);
  }
  const visibleBlocker = fit(String(firstBlocker), blockerWidth);
  const contentWidth = stringWidth(glyph) + stringWidth(` ${label} ${visibleBlocker}${suffix}`);
  return (
    <span>
      <span fg={dim}>
        <strong>{glyph}</strong>
        {` ${label} `}
      </span>
      <span fg={selected ? theme.palette.selectionInk : theme.palette.warn}>{visibleBlocker}</span>
      <span fg={dim}>{suffix}</span>
      <span>{" ".repeat(Math.max(0, statusWidth + 1 - contentWidth))}</span>
    </span>
  );
}

function rowColors(theme: QuestTheme, item: QuestLogItem, selected: boolean) {
  if (selected) {
    return {
      muted: theme.palette.selectionInk,
      primary: theme.palette.selectionInk,
      status: theme.palette.selectionInk,
    };
  }
  if (item.computedState === "blocked") {
    return {
      muted: theme.palette.textDim,
      primary: theme.palette.textDim,
      status: theme.palette.textDim,
    };
  }
  return {
    muted: theme.palette.textMuted,
    primary: theme.palette.textPrimary,
    status: theme.status[item.status].color,
  };
}

export function pullRequestGlyphColor(
  theme: QuestTheme,
  item: QuestLogItem,
  selected: boolean,
): string | null {
  if (item.prState === null) {
    return null;
  }
  if (selected) {
    return theme.palette.selectionInk;
  }
  return item.prState === "awaiting-review" ? theme.palette.pullRequest : theme.palette.textDim;
}

function pullRequestPrefixFor(theme: QuestTheme, item: QuestLogItem): string {
  return item.prState === null ? "" : `${theme.glyphs.pullRequest} `;
}

function pullRequestMarker(
  theme: QuestTheme,
  item: QuestLogItem,
  selected: boolean,
  prefix: string,
) {
  const color = pullRequestGlyphColor(theme, item, selected);
  return color === null || prefix === "" ? null : <span fg={color}>{prefix}</span>;
}

interface TitlePrefixLayout {
  readonly blockedPrefix: string;
  readonly pullRequestPrefix: string;
  readonly titleWidth: number;
}

function titlePrefixLayout(
  theme: QuestTheme,
  item: QuestLogItem,
  availableWidth: number,
): TitlePrefixLayout {
  const blockedPrefix =
    item.computedState === "blocked" ? "" : item.blocked ? `${theme.glyphs.blockedFlag} ` : "";
  const pullRequestPrefix = pullRequestPrefixFor(theme, item);
  const candidates = [
    { blockedPrefix, pullRequestPrefix },
    { blockedPrefix: "", pullRequestPrefix },
    { blockedPrefix, pullRequestPrefix: "" },
    { blockedPrefix: "", pullRequestPrefix: "" },
  ];
  const fallback = { blockedPrefix: "", pullRequestPrefix: "" };
  const selected =
    candidates.find(
      (candidate) =>
        stringWidth(candidate.blockedPrefix) + stringWidth(candidate.pullRequestPrefix) + 1 <=
        availableWidth,
    ) ?? fallback;
  return {
    ...selected,
    titleWidth: Math.max(
      1,
      availableWidth -
        stringWidth(selected.blockedPrefix) -
        stringWidth(selected.pullRequestPrefix),
    ),
  };
}

function laneText(theme: QuestTheme, marker: QuestLogLaneMarker | null): string {
  if (marker === null) {
    return "";
  }
  const glyph = marker.edge === "start" ? theme.glyphs.laneStart : theme.glyphs.laneEnd;
  const partners = compactLanePartners(marker.partnerIds);
  return `${glyph} ${marker.label}${partners === "" ? "" : ` ${partners}`}`;
}

function rowText(
  theme: QuestTheme,
  item: QuestLogItem,
  titleWidth: number,
  statusWidth: number,
  showKind: boolean,
  showAssignee: boolean,
  selected: boolean,
  laneMarker: QuestLogLaneMarker | null,
) {
  const status = theme.status[item.status];
  const colors = rowColors(theme, item, selected);
  const markerText = laneText(theme, laneMarker);
  const visibleMarkerText =
    markerText === "" || titleWidth <= 2 ? "" : fit(markerText, titleWidth - 2);
  const markerSuffix = visibleMarkerText === "" ? "" : ` ${visibleMarkerText}`;
  const fittedTitleWidth = Math.max(1, titleWidth - stringWidth(markerSuffix));
  const titleLayout = titlePrefixLayout(theme, item, fittedTitleWidth);
  return (
    <span>
      <span fg={colors.muted}>{`${pad(String(item.id), 5, "right")} `}</span>
      {item.computedState === "blocked"
        ? blockedStatusCell(theme, item, selected, statusWidth)
        : statusCell(
            status.glyph,
            ` ${pad(status.label, Math.max(1, statusWidth - stringWidth(status.glyph) - 1))} `,
            colors.status,
          )}
      {showKind ? <span fg={colors.muted}>{`${pad(item.kind, 7)} `}</span> : null}
      <span
        fg={
          selected || item.computedState === "blocked"
            ? colors.muted
            : questPriorityInk(theme, item.priority)
        }
      >
        {`${pad(`${theme.glyphs.priority}${item.priority}`, 4)} `}
      </span>
      {showAssignee ? <span fg={colors.muted}>{`${pad(item.assignee ?? "—", 16)} `}</span> : null}
      <span fg={colors.primary}>{titleLayout.blockedPrefix}</span>
      {pullRequestMarker(theme, item, selected, titleLayout.pullRequestPrefix)}
      <span fg={colors.primary}>{fit(item.title, titleLayout.titleWidth)}</span>
      {visibleMarkerText === "" ? null : (
        <span fg={selected ? theme.palette.selectionInk : theme.palette.lane}>{markerSuffix}</span>
      )}
    </span>
  );
}

export function QuestListPane({
  height,
  hiddenDoneCount,
  items,
  laneClusters,
  loading,
  paneWidth,
  selectedIndex,
  terminalWidth,
  totalCount,
}: {
  readonly height: number;
  readonly hiddenDoneCount: number;
  readonly items: readonly QuestLogItem[];
  readonly laneClusters: readonly PlanLaneCluster[];
  readonly loading: boolean;
  readonly paneWidth: number;
  readonly selectedIndex: number;
  readonly terminalWidth: number;
  readonly totalCount: number;
}) {
  const theme = useQuestTheme();
  const showAssignee = terminalWidth >= 100;
  const showKind = terminalWidth >= 90;
  const statusWidth = items.reduce(
    (width, item) =>
      Math.max(
        width,
        stringWidth(blockedStatusText(theme, item) ?? questStatusText(theme.status[item.status])),
      ),
    13,
  );
  const titleWidth = Math.max(
    8,
    paneWidth - 5 - 1 - statusWidth - 1 - (showKind ? 8 : 0) - 4 - 1 - (showAssignee ? 17 : 0),
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
        <strong>{listHeader(showKind, showAssignee, statusWidth)}</strong>
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
          const laneMarker = laneMarkerFor(actualIndex, items, laneClusters);
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
                  <strong>
                    {rowText(
                      theme,
                      item,
                      titleWidth,
                      statusWidth,
                      showKind,
                      showAssignee,
                      true,
                      laneMarker,
                    )}
                  </strong>
                </text>
              ) : (
                <text>
                  {rowText(
                    theme,
                    item,
                    titleWidth,
                    statusWidth,
                    showKind,
                    showAssignee,
                    false,
                    laneMarker,
                  )}
                </text>
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

interface DetailTextLine {
  readonly key: string;
  readonly text: string;
}

function keyedTextLines(lines: readonly string[], prefix: string): readonly DetailTextLine[] {
  return lines.map((text, index) => ({ key: `${prefix}:${index}`, text }));
}

interface LaneConflictGroup {
  readonly area: string | null;
  readonly files: readonly string[];
  readonly kind: PlanLaneCluster["kind"];
  readonly partnerIds: readonly number[];
}

function laneConflictGroupsFor(
  itemId: number,
  clusters: readonly PlanLaneCluster[],
): readonly LaneConflictGroup[] {
  const groups = new Map<
    string,
    {
      readonly area: string | null;
      readonly files: readonly string[];
      readonly kind: PlanLaneCluster["kind"];
      readonly partnerIds: Set<number>;
    }
  >();
  for (const cluster of clusters) {
    if (!cluster.quest_ids.includes(itemId)) {
      continue;
    }
    const partnerIds = cluster.quest_ids.filter((questId) => questId !== itemId);
    if (partnerIds.length === 0) {
      continue;
    }
    const key = `${cluster.kind}\0${cluster.area ?? ""}\0${cluster.files.join("\0")}`;
    const existing = groups.get(key);
    if (existing === undefined) {
      groups.set(key, {
        area: cluster.area,
        files: cluster.files,
        kind: cluster.kind,
        partnerIds: new Set(partnerIds),
      });
      continue;
    }
    for (const partnerId of partnerIds) {
      existing.partnerIds.add(partnerId);
    }
  }
  return [...groups.values()]
    .map((group) => ({
      area: group.area,
      files: group.files,
      kind: group.kind,
      partnerIds: [...group.partnerIds].sort((left, right) => left - right),
    }))
    .sort((left, right) => {
      const leftPartner = left.partnerIds[0] ?? 0;
      const rightPartner = right.partnerIds[0] ?? 0;
      return leftPartner - rightPartner || left.kind.localeCompare(right.kind);
    });
}

function laneConflictGroupText(group: LaneConflictGroup): string {
  const partners = group.partnerIds.join(", ");
  if (group.kind === "shared_files") {
    return `${partners} via ${group.files.join(", ") || "<unknown file>"}`;
  }
  return `${partners} same lane${group.area === null ? "" : ` (${group.area})`}`;
}

export function laneConflictLinesFor(
  itemId: number,
  clusters: readonly PlanLaneCluster[],
  width: number,
): readonly string[] {
  const groups = laneConflictGroupsFor(itemId, clusters);
  if (groups.length === 0) {
    return [];
  }
  return wrapText(`conflicts: ${groups.map(laneConflictGroupText).join("; ")}`, width);
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
  readonly continuation: boolean;
  readonly entry: QuestLogEvidenceEntry | null;
  readonly indent: string;
  readonly key: string;
  readonly kind: "entry" | "empty" | "loading" | "marker";
  readonly text: string | null;
}

function isCompleteEvidenceStage(stage: string): boolean {
  return stage === "fix" || stage === "verify" || stage === "signoff";
}

function detailEvidenceRows(
  detail: QuestLogDetail | null,
  width: number,
  theme: QuestTheme,
): readonly DetailEvidenceRow[] {
  if (detail === null) {
    return [
      {
        continuation: false,
        entry: null,
        indent: "",
        key: "evidence:loading",
        kind: "loading",
        text: "loading detail…",
      },
    ];
  }
  if (detail.evidence.length === 0) {
    return [
      {
        continuation: false,
        entry: null,
        indent: "",
        key: "evidence:empty",
        kind: "empty",
        text: null,
      },
    ];
  }
  return detail.evidence.flatMap((entry) => {
    const complete = isCompleteEvidenceStage(entry.stage);
    const glyph = complete ? theme.glyphs.evidenceComplete : theme.glyphs.evidencePending;
    const prefix = `${glyph} `;
    const lines = wrapText(
      `${entry.filename} ${entry.stage} · ${entry.actor}`,
      Math.max(1, width - stringWidth(prefix)),
    );
    return lines.map((text, index) => ({
      continuation: index > 0,
      entry,
      indent: " ".repeat(stringWidth(prefix)),
      key: `evidence:${entry.id}:${index}`,
      kind: "entry" as const,
      text,
    }));
  });
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

function activityBase(event: QuestLogEventEntry): {
  readonly label: string;
  readonly timestamp: string;
} {
  return {
    label: `${event.action} ${event.actor}`,
    timestamp: detailTime(event.at),
  };
}

function eventRows(
  event: QuestLogEventEntry,
  width: number,
  includeDetails: boolean,
): readonly DetailActivityRow[] {
  const base = activityBase(event);
  const labelWidth = Math.max(1, width - stringWidth(base.timestamp) - 1);
  const labelLines = wrapText(base.label, labelWidth);
  const firstLabel = labelLines[0] ?? "";
  const baseWidth =
    stringWidth(base.timestamp) + (firstLabel === "" ? 0 : stringWidth(firstLabel) + 1);
  const detailWidth = Math.max(0, width - baseWidth - 3);
  const firstRow: DetailActivityRow = {
    continuation: false,
    detail: null,
    detailWidth: 0,
    eventId: event.id,
    indent: "",
    kind: "event",
    key: `event-${event.id}-0`,
    label: firstLabel,
    placeholder: null,
    timestamp: base.timestamp,
  };
  if (labelLines.length > 1) {
    const indentLength = Math.min(Math.max(0, width - 1), stringWidth(base.timestamp) + 1);
    const labelContinuationRows = labelLines.slice(1).map((label, index) => ({
      ...firstRow,
      continuation: true,
      detail: label,
      detailWidth: labelWidth,
      indent: " ".repeat(indentLength),
      key: `event-${event.id}-label-${index + 1}`,
      label: "",
      timestamp: "",
    }));
    const detailLines =
      includeDetails && event.detailSummary !== null
        ? wrapText(event.detailSummary, Math.max(1, width - indentLength))
        : [];
    return [
      firstRow,
      ...labelContinuationRows,
      ...detailLines.map((detail, index) => ({
        ...firstRow,
        continuation: true,
        detail,
        detailWidth: Math.max(1, width - indentLength),
        indent: " ".repeat(indentLength),
        key: `event-${event.id}-detail-${index + 1}`,
        label: "",
        timestamp: "",
      })),
    ];
  }
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

export interface DetailPaneLayout {
  readonly activityRows: readonly DetailActivityRow[];
  readonly chainRows: readonly DetailChainRow[];
  readonly descriptionBodyRows: number;
  readonly descriptionLines: readonly DetailTextLine[];
  readonly evidenceRows: readonly DetailEvidenceRow[];
  readonly fileBlocks: readonly DetailFileBlock[];
  readonly headerRows: number;
  readonly laneConflictLines: readonly DetailTextLine[];
  readonly showActivity: boolean;
  readonly showChain: boolean;
  readonly showDescription: boolean;
  readonly showEvidence: boolean;
  readonly showFiles: boolean;
  readonly showFooter: boolean;
  readonly usedRows: number;
}

export function buildDetailLayout(
  item: QuestLogItem,
  detail: QuestLogDetail | null,
  paneWidth: number,
  rows: number,
  theme: QuestTheme = DENSE_THEME,
  laneClusters: readonly PlanLaneCluster[] = [],
): DetailPaneLayout {
  const rowBudget = Math.max(1, Math.floor(rows));
  const width = Math.max(1, Math.floor(paneWidth) - 2);
  const description = wrapText(item.description || "—", width);
  const naturalLaneConflictLines = keyedTextLines(
    laneConflictLinesFor(item.id, laneClusters, width),
    "lane-conflict",
  );
  const naturalFileBlocks = fileBlocks(item.predictedFiles, width);
  const naturalEvidenceRows = detailEvidenceRows(detail, width, theme);
  const naturalChainBlocks = detailChainBlocks(theme, item, detail, width);
  const fullActivityRows = detailActivityRows(detail, width, true);
  const showChain = naturalChainBlocks.length > 0;
  const showFiles = naturalFileBlocks.length > 0;
  const headerRows = Math.min(DETAIL_HEADER_ROWS, rowBudget);
  const showFooter = rowBudget >= DETAIL_HEADER_ROWS + 2;
  const descriptionLines = keyedTextLines(description, "description");
  const chainRows = flattenChainBlocks(naturalChainBlocks);
  const fileRows = naturalFileBlocks.reduce((total, block) => total + block.lines.length, 0);
  const bodyRows =
    naturalLaneConflictLines.length +
    (showFiles ? fileRows : 0) +
    1 +
    descriptionLines.length +
    1 +
    naturalEvidenceRows.length +
    (showChain ? 1 + chainRows.length : 0) +
    1 +
    fullActivityRows.length;
  return {
    activityRows: fullActivityRows,
    chainRows,
    descriptionBodyRows: descriptionLines.length,
    descriptionLines,
    evidenceRows: naturalEvidenceRows,
    fileBlocks: naturalFileBlocks,
    headerRows,
    laneConflictLines: naturalLaneConflictLines,
    showActivity: true,
    showChain,
    showDescription: true,
    showEvidence: true,
    showFiles,
    showFooter,
    usedRows: headerRows + bodyRows + (showFooter ? DETAIL_FOOTER_ROWS : 0),
  };
}

export type DetailDocumentSection = "activity" | "chain" | "description" | "evidence";

export type DetailDocumentLine =
  | { readonly key: string; readonly kind: "activity"; readonly row: DetailActivityRow }
  | { readonly key: string; readonly kind: "chain"; readonly row: DetailChainRow }
  | { readonly key: string; readonly kind: "description"; readonly text: string }
  | {
      readonly count: number;
      readonly key: string;
      readonly kind: "section";
      readonly section: "evidence";
    }
  | {
      readonly key: string;
      readonly kind: "section";
      readonly section: Exclude<DetailDocumentSection, "evidence">;
    }
  | { readonly key: string; readonly kind: "evidence"; readonly row: DetailEvidenceRow }
  | { readonly key: string; readonly kind: "file"; readonly text: string }
  | { readonly key: string; readonly kind: "lane-conflict"; readonly text: string };

export interface DetailPaneDocument {
  readonly lines: readonly DetailDocumentLine[];
}

function detailDocumentLinesForLayout(
  layout: DetailPaneLayout,
  detail: QuestLogDetail | null,
): readonly DetailDocumentLine[] {
  const lines: DetailDocumentLine[] = layout.laneConflictLines.map((line) => ({
    key: line.key,
    kind: "lane-conflict",
    text: line.text,
  }));
  if (layout.showFiles) {
    lines.push(
      ...layout.fileBlocks.flatMap((block) =>
        block.lines.map((line) => ({ key: line.key, kind: "file" as const, text: line.text })),
      ),
    );
  }
  if (layout.showDescription) {
    lines.push({ key: "section:description", kind: "section", section: "description" });
    lines.push(
      ...layout.descriptionLines.map((line) => ({
        key: line.key,
        kind: "description" as const,
        text: line.text,
      })),
    );
  }
  if (layout.showEvidence) {
    lines.push({
      count: detail?.evidence.length ?? 0,
      key: "section:evidence",
      kind: "section",
      section: "evidence",
    });
    lines.push(
      ...layout.evidenceRows.map((row) => ({ key: row.key, kind: "evidence" as const, row })),
    );
  }
  if (layout.showChain) {
    lines.push({ key: "section:chain", kind: "section", section: "chain" });
    lines.push(...layout.chainRows.map((row) => ({ key: row.key, kind: "chain" as const, row })));
  }
  if (layout.showActivity) {
    lines.push({ key: "section:activity", kind: "section", section: "activity" });
    lines.push(
      ...layout.activityRows.map((row) => ({ key: row.key, kind: "activity" as const, row })),
    );
  }
  return lines;
}

export function buildDetailDocument(
  item: QuestLogItem,
  detail: QuestLogDetail | null,
  paneWidth: number,
  theme: QuestTheme = DENSE_THEME,
  laneClusters: readonly PlanLaneCluster[] = [],
): DetailPaneDocument {
  const layout = buildDetailLayout(
    item,
    detail,
    paneWidth,
    DETAIL_HEADER_ROWS + 2,
    theme,
    laneClusters,
  );
  return { lines: detailDocumentLinesForLayout(layout, detail) };
}

export interface DetailPaneScrollMetrics {
  readonly contentRows: number;
  readonly headerRows: number;
  readonly maxOffset: number;
  readonly showFooter: boolean;
  readonly viewportRows: number;
}

export function detailPaneScrollMetrics(
  item: QuestLogItem,
  detail: QuestLogDetail | null,
  paneWidth: number,
  rows: number,
  theme: QuestTheme = DENSE_THEME,
  laneClusters: readonly PlanLaneCluster[] = [],
): DetailPaneScrollMetrics {
  const rowBudget = Math.max(1, Math.floor(rows));
  const headerRows = Math.min(DETAIL_HEADER_ROWS, rowBudget);
  const showFooter = rowBudget >= DETAIL_HEADER_ROWS + 2;
  const viewportRows = Math.max(0, rowBudget - headerRows - (showFooter ? 1 : 0));
  const contentRows = buildDetailDocument(item, detail, paneWidth, theme, laneClusters).lines
    .length;
  return {
    contentRows,
    headerRows,
    maxOffset: Math.max(0, contentRows - viewportRows),
    showFooter,
    viewportRows,
  };
}

function DetailEvidenceRowView({
  row,
  theme,
  width,
}: {
  readonly row: DetailEvidenceRow;
  readonly theme: QuestTheme;
  readonly width: number;
}) {
  if (row.kind === "loading") {
    return (
      <text fg={theme.palette.textDim} key={row.key} wrapMode="none">
        {fit(row.text ?? "loading detail…", width)}
      </text>
    );
  }
  if (row.kind === "empty") {
    return (
      <text fg={theme.palette.textDim} key={row.key} wrapMode="none">
        {fit(theme.labels.evidenceEmpty, width)}
      </text>
    );
  }
  if (row.kind === "marker") {
    return (
      <text fg={theme.palette.textDim} key={row.key} wrapMode="none">
        {fit("…", width)}
      </text>
    );
  }
  const evidence = row.entry;
  if (evidence === null) {
    return null;
  }
  const complete = isCompleteEvidenceStage(evidence.stage);
  const glyph = complete ? theme.glyphs.evidenceComplete : theme.glyphs.evidencePending;
  const prefix = `${glyph} `;
  return (
    <text key={row.key} wrapMode="none">
      {row.continuation ? (
        <span fg={theme.palette.textDim}>{row.indent}</span>
      ) : (
        <span fg={complete ? theme.status.complete.color : theme.palette.warn}>{prefix}</span>
      )}
      <span fg={theme.palette.textPrimary}>{row.text ?? ""}</span>
    </text>
  );
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
      {rows.map((row) => (
        <DetailEvidenceRowView key={row.key} row={row} theme={theme} width={width} />
      ))}
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
  const statusSuffix = `${questStatusText(status)} · ${theme.labels.statusPhrase[item.status]}`;
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

function detailSectionLabel(
  theme: QuestTheme,
  section: DetailDocumentSection,
  count: number | undefined,
): string {
  if (section === "description") {
    return theme.labels.description;
  }
  if (section === "evidence") {
    return `${theme.labels.evidence} · ${count ?? 0}`;
  }
  if (section === "chain") {
    return theme.labels.chain;
  }
  return theme.labels.activity;
}

function DetailDocumentLineView({
  item,
  line,
  paneWidth,
  theme,
}: {
  readonly item: QuestLogItem;
  readonly line: DetailDocumentLine;
  readonly paneWidth: number;
  readonly theme: QuestTheme;
}) {
  switch (line.kind) {
    case "activity":
      return <DetailActivityRowView row={line.row} theme={theme} />;
    case "chain":
      return <DetailChainRowView item={item} row={line.row} theme={theme} />;
    case "description":
      return (
        <text fg={theme.palette.textPrimary} key={line.key} wrapMode="none">
          {line.text}
        </text>
      );
    case "evidence":
      return <DetailEvidence rows={[line.row]} width={Math.max(1, paneWidth)} />;
    case "file":
      return (
        <text fg={theme.palette.textMuted} key={line.key} wrapMode="none">
          {line.text}
        </text>
      );
    case "lane-conflict":
      return (
        <text fg={theme.palette.warn} key={line.key} wrapMode="none">
          {line.text}
        </text>
      );
    case "section":
      return (
        <text fg={theme.palette.sectionLabel} key={line.key}>
          <strong>
            {detailSectionLabel(
              theme,
              line.section,
              line.section === "evidence" ? line.count : undefined,
            )}
          </strong>
        </text>
      );
  }
}

function detailScrollIndicator(
  offset: number,
  viewportRows: number,
  contentRows: number,
  theme: QuestTheme,
): string {
  const trackLength = 12;
  const scrollExtent = Math.max(1, Math.round((viewportRows / contentRows) * trackLength));
  const maxPosition = Math.max(0, trackLength - scrollExtent);
  const scrollPosition = Math.min(
    maxPosition,
    Math.round((offset / Math.max(1, contentRows - viewportRows)) * maxPosition),
  );
  return `${theme.glyphs.scrollbarTrack.repeat(scrollPosition)}${theme.glyphs.scrollbarFull.repeat(scrollExtent)}${theme.glyphs.scrollbarTrack.repeat(Math.max(0, trackLength - scrollPosition - scrollExtent))}`;
}

export function DetailPane({
  detail,
  item,
  laneClusters = [],
  paneWidth,
  rows,
  scrollOffset = 0,
}: {
  readonly detail: QuestLogDetail | null;
  readonly item: QuestLogItem | undefined;
  readonly laneClusters?: readonly PlanLaneCluster[];
  readonly paneWidth: number;
  readonly rows: number;
  readonly scrollOffset?: number;
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
  const document = buildDetailDocument(item, detail, paneWidth, theme, laneClusters);
  const metrics = detailPaneScrollMetrics(item, detail, paneWidth, rows, theme, laneClusters);
  const boundedOffset = Math.min(Math.max(0, scrollOffset), metrics.maxOffset);
  const scrollable = metrics.contentRows > metrics.viewportRows;
  const visibleLines = scrollable
    ? document.lines.slice(boundedOffset, boundedOffset + metrics.viewportRows)
    : document.lines;
  const bodyRows = scrollable ? metrics.viewportRows : document.lines.length;
  const footer = scrollable
    ? `J/K detail · ${detailScrollIndicator(boundedOffset, metrics.viewportRows, metrics.contentRows, theme)} ${boundedOffset + 1}-${Math.min(metrics.contentRows, boundedOffset + metrics.viewportRows)}/${metrics.contentRows} · E open evidence · p open PR · q quit`
    : "E open evidence · p open PR · q quit";
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
        headerRows={metrics.headerRows}
        item={item}
        paneWidth={paneWidth}
        status={status}
        theme={theme}
      />
      {bodyRows > 0 ? (
        <box
          style={{
            flexDirection: "column",
            height: bodyRows,
            overflow: "hidden",
            width: "100%",
          }}
        >
          {visibleLines.map((line) => (
            <DetailDocumentLineView
              item={item}
              key={line.key}
              line={line}
              paneWidth={Math.max(1, paneWidth - 2)}
              theme={theme}
            />
          ))}
        </box>
      ) : null}
      {metrics.showFooter ? (
        <text fg={theme.palette.textDim} wrapMode="none">
          {fit(footer, Math.max(1, paneWidth - 2))}
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

export function FooterKeymap({
  planAvailable = false,
  sortMode = "plan",
}: {
  readonly planAvailable?: boolean;
  readonly sortMode?: "flat" | "plan";
} = {}) {
  const theme = useQuestTheme();
  const actions = [
    ["tab", "areas"],
    ["r", "repo"],
    ...(planAvailable ? [["o", sortMode === "plan" ? "flat" : "plan"] as const] : []),
    ["d", "done"],
    ["j/k", "move"],
    ["J/K", "detail"],
    ["E", "evidence"],
    ["p", "pr"],
    ["t", "theme"],
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
