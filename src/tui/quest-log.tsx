import { useKeyboard, useRenderer, useTerminalDimensions } from "@opentui/react";
import { useEffect, useMemo, useRef, useState } from "react";

import {
  EMPTY_QUEST_LOG_SIGNOFF,
  type QuestLogItem,
  type QuestLogRuntime,
  type QuestLogSignoffLens,
  type QuestLogSnapshot,
} from "../services/quest-log-model";
import {
  AppHeader,
  type AreaTab,
  areaLabel,
  areaTabKey,
  DetailPane,
  detailPaneScrollMetrics,
  FooterKeymap,
  type HeaderCounts,
  HorizontalRule,
  QuestListPane,
  SignoffListPane,
  SignoffSubheader,
  StatusRow,
  TabsRow,
} from "./components";
import { openEvidenceWithNotice } from "./evidence";
import {
  INITIAL_QUEST_LOG_INTERACTION,
  type QuestLogInteractionState,
  type QuestLogKey,
  type QuestLogLens,
  type QuestLogSortMode,
  reduceReadOnlyInteraction,
} from "./interaction";
import { MAIN_CHROME_ROWS, mainPaneGeometry } from "./layout";
import { openPrWithNotice } from "./pr";
import {
  DENSE_THEME,
  findQuestTheme,
  QUEST_THEMES,
  type QuestTheme,
  questThemeAfter,
} from "./theme";
import { QuestThemeContext, useQuestTheme } from "./theme-context";
import { createThemeSaver } from "./theme-saver";
import type { ViewerTheme } from "./theme-selection";

function areaTabs(items: readonly QuestLogItem[]): readonly (string | null)[] {
  const areas = new Set<string>();
  let includesUnassigned = false;
  for (const item of items) {
    if (item.area === null) {
      includesUnassigned = true;
    } else {
      areas.add(item.area);
    }
  }
  const sorted: (string | null)[] = [...areas].sort((left, right) => left.localeCompare(right));
  if (includesUnassigned) {
    sorted.push(null);
  }
  return sorted;
}

function visibleQuestLogItems(
  items: readonly QuestLogItem[],
  showDone: boolean,
): readonly QuestLogItem[] {
  return showDone
    ? items
    : items.filter((item) => item.status !== "complete" && item.status !== "dropped");
}

function itemsForArea(
  items: readonly QuestLogItem[],
  area: string | null | undefined,
): readonly QuestLogItem[] {
  if (area === undefined) {
    return items;
  }
  return items.filter((item) => item.area === area);
}

function selectedQuest(
  items: readonly QuestLogItem[],
  selectedIndex: number,
): QuestLogItem | undefined {
  return items[selectedIndex];
}

function questIdentity(item: QuestLogItem): string {
  return `${item.repo}\u0000${item.id}`;
}

function selectedIndexForQuest(
  items: readonly QuestLogItem[],
  interaction: QuestLogInteractionState,
): number {
  if (items.length === 0) {
    return 0;
  }
  if (interaction.selectedQuestKey !== undefined) {
    const identityIndex = items.findIndex(
      (item) => questIdentity(item) === interaction.selectedQuestKey,
    );
    if (identityIndex >= 0) {
      return identityIndex;
    }
  }
  if (interaction.selectedQuestId !== undefined) {
    const identityIndex = items.findIndex((item) => item.id === interaction.selectedQuestId);
    if (identityIndex >= 0) {
      return identityIndex;
    }
  }
  return Math.min(Math.max(0, interaction.selectedIndex), items.length - 1);
}

function headerCounts(items: readonly QuestLogItem[]): HeaderCounts {
  return items.reduce<HeaderCounts>(
    (counts, item) => ({
      active: counts.active + (item.status === "accepted" ? 1 : 0),
      blocked: counts.blocked + (item.blocked ? 1 : 0),
      complete: counts.complete + (item.status === "complete" ? 1 : 0),
      ready: counts.ready + (item.status === "ready" ? 1 : 0),
      review: counts.review + (item.status === "turned_in" ? 1 : 0),
      total: counts.total + 1,
    }),
    { active: 0, blocked: 0, complete: 0, ready: 0, review: 0, total: 0 },
  );
}

function tabsForAreas(
  areas: readonly (string | null | undefined)[],
  items: readonly QuestLogItem[],
): readonly AreaTab[] {
  return areas.map((area) => ({
    count: area === undefined ? items.length : items.filter((item) => item.area === area).length,
    key: areaTabKey(area),
    label: areaLabel(area),
  }));
}

function useQuestDetail(runtime: QuestLogRuntime, current: QuestLogItem | undefined) {
  const [detail, setDetail] = useState<Awaited<ReturnType<QuestLogRuntime["loadDetail"]>> | null>(
    null,
  );
  const [detailStale, setDetailStale] = useState(false);
  const detailKey =
    current === undefined ? "" : `${current.repo}\u0000${current.id}\u0000${current.updatedAt}`;

  useEffect(() => {
    if (detailKey === "") {
      setDetail(null);
      setDetailStale(false);
      return;
    }
    setDetail(null);
    setDetailStale(false);
    const separator = detailKey.indexOf("\u0000");
    const secondSeparator = detailKey.indexOf("\u0000", separator + 1);
    const repository = detailKey.slice(0, separator);
    const id = Number(detailKey.slice(separator + 1, secondSeparator));
    let cancelled = false;
    let inFlight = false;
    let hasLoaded = false;
    const refresh = (): void => {
      if (cancelled || inFlight) {
        return;
      }
      inFlight = true;
      runtime
        .loadDetail(id, repository)
        .then(
          (value) => {
            if (!cancelled) {
              hasLoaded = true;
              setDetailStale(false);
              setDetail(value);
            }
          },
          () => {
            if (!cancelled && hasLoaded) {
              setDetailStale(true);
            }
          },
        )
        .finally(() => {
          inFlight = false;
        });
    };
    refresh();
    const refreshTimer = setInterval(refresh, Math.max(1_000, runtime.pollIntervalMs));
    return () => {
      cancelled = true;
      clearInterval(refreshTimer);
    };
  }, [detailKey, runtime, runtime.pollIntervalMs]);

  return { detail, detailStale };
}

function ReadOnlyLayout({
  branch,
  counts,
  current,
  detail,
  detailScrollOffset,
  hiddenDoneCount,
  identity,
  lens,
  activeAreaIndex,
  activeSelectedIndex,
  notice,
  policyItems,
  planAvailable,
  signoff,
  signoffItems,
  signoffSelectedIndex,
  sortMode,
  snapshot,
  visibleItems,
  width,
  height,
}: {
  readonly branch: string | undefined;
  readonly counts: HeaderCounts;
  readonly current: QuestLogItem | undefined;
  readonly detail: Awaited<ReturnType<QuestLogRuntime["loadDetail"]>> | null;
  readonly detailScrollOffset: number;
  readonly hiddenDoneCount: number;
  readonly identity: string | undefined;
  readonly lens: QuestLogLens;
  readonly activeAreaIndex: number;
  readonly activeSelectedIndex: number;
  readonly notice: string;
  readonly policyItems: readonly QuestLogItem[];
  readonly planAvailable: boolean;
  readonly signoff: QuestLogSignoffLens;
  readonly signoffItems: readonly QuestLogItem[];
  readonly signoffSelectedIndex: number;
  readonly sortMode: QuestLogSortMode;
  readonly snapshot: QuestLogSnapshot;
  readonly visibleItems: readonly QuestLogItem[];
  readonly width: number;
  readonly height: number;
}) {
  const theme = useQuestTheme();
  const geometry = mainPaneGeometry(width, height);
  const mainHeight = Math.max(1, height - MAIN_CHROME_ROWS);
  const listHeight = typeof geometry.listHeight === "number" ? geometry.listHeight : mainHeight;
  const areas = useMemo(() => [undefined, ...areaTabs(policyItems)], [policyItems]);
  const tabs = useMemo(() => tabsForAreas(areas, policyItems), [areas, policyItems]);
  const scope = snapshot.scope === "current" ? (snapshot.currentRepo ?? "current") : "all";
  return (
    <box
      style={{
        backgroundColor: theme.palette.background,
        flexDirection: "column",
        height: "100%",
        width: "100%",
      }}
    >
      <AppHeader
        branch={branch}
        counts={counts}
        identity={identity}
        lens={lens}
        repo={scope}
        signoffCounts={{ awaiting: signoff.awaitingCount, signed: signoff.signedCount }}
        width={width}
      />
      <HorizontalRule width={width} />
      {lens === "signoff" ? (
        <SignoffSubheader scope={scope} width={width} />
      ) : (
        <TabsRow activeIndex={activeAreaIndex} scope={scope} tabs={tabs} width={width} />
      )}
      <HorizontalRule width={width} />
      <box
        style={{
          flexDirection: geometry.direction,
          flexGrow: 1,
          overflow: "hidden",
          width: "100%",
        }}
      >
        <box style={{ flexShrink: 0, height: geometry.listHeight, width: geometry.listWidth }}>
          {lens === "signoff" ? (
            <SignoffListPane
              height={geometry.narrow ? listHeight : mainHeight}
              items={signoffItems}
              lens={signoff}
              loading={snapshot.loading}
              paneWidth={geometry.listWidth}
              selectedIndex={signoffSelectedIndex}
              terminalWidth={width}
            />
          ) : (
            <QuestListPane
              height={geometry.narrow ? listHeight : mainHeight}
              hiddenDoneCount={hiddenDoneCount}
              items={visibleItems}
              laneClusters={snapshot.plan?.laneClusters ?? []}
              loading={snapshot.loading}
              paneWidth={geometry.listWidth}
              selectedIndex={activeSelectedIndex}
              terminalWidth={width}
              totalCount={policyItems.length}
            />
          )}
        </box>
        {geometry.narrow ? (
          <HorizontalRule width={width} />
        ) : (
          <box style={{ height: "100%", overflow: "hidden", width: 1 }}>
            <text fg={theme.palette.borderIdle}>
              {theme.glyphs.ruleVertical.repeat(Math.max(1, mainHeight))}
            </text>
          </box>
        )}
        <box style={{ flexGrow: 1, height: "100%", width: geometry.detailWidth }}>
          <DetailPane
            detail={detail}
            item={current}
            laneClusters={lens === "dev" ? (snapshot.plan?.laneClusters ?? []) : []}
            paneWidth={geometry.detailWidth}
            rows={geometry.detailRows}
            scrollOffset={detailScrollOffset}
          />
        </box>
      </box>
      <HorizontalRule width={width} />
      <StatusRow notice={notice} refreshing={snapshot.refreshing} width={width} />
      <FooterKeymap lens={lens} planAvailable={planAvailable} sortMode={sortMode} width={width} />
    </box>
  );
}

function initialThemeNotice(warnings: readonly string[]): string {
  return warnings.length === 0 ? "Watching for quest changes" : warnings.join(" · ");
}

function savedThemeNotice(theme: QuestTheme): string {
  return `Theme: ${theme.name} (saved as default)`;
}

function unsavedThemeNotice(theme: QuestTheme, reason: string): string {
  return `Theme: ${theme.name} (not saved: ${reason})`;
}

function keyboardInteractionResult(
  active: QuestLogInteractionState,
  key: QuestLogKey,
  snapshot: QuestLogSnapshot,
  signoffItems: readonly QuestLogItem[],
  areas: readonly (string | null | undefined)[],
  areaKeys: readonly string[],
  detailContentRows: number,
  detailViewportRows: number,
): ReturnType<typeof reduceReadOnlyInteraction> {
  const keyboardAreaKeys = active.lens === "signoff" ? ["all"] : areaKeys;
  const keyboardAreas = active.lens === "signoff" ? [undefined] : areas;
  const keyboardAreaIndex = Math.max(0, keyboardAreaKeys.indexOf(active.areaKey));
  const activeArea = keyboardAreas[keyboardAreaIndex];
  const activeOrderedItems =
    active.lens === "signoff"
      ? signoffItems
      : active.sortMode === "plan" && snapshot.plan !== null
        ? snapshot.plan.items
        : snapshot.items;
  const activeItems =
    active.lens === "signoff"
      ? activeOrderedItems
      : itemsForArea(visibleQuestLogItems(activeOrderedItems, active.showDone), activeArea);
  const activeQuest = selectedQuest(activeItems, selectedIndexForQuest(activeItems, active));
  return reduceReadOnlyInteraction(active, key, {
    areaCount: keyboardAreaKeys.length,
    areaKeys: keyboardAreaKeys,
    detailContentRows,
    detailViewportRows,
    ...(activeQuest === undefined ? {} : { pr: activeQuest.pr }),
    questId: activeQuest?.id,
    ...(activeQuest === undefined ? {} : { repository: activeQuest.repo }),
    visibleCount: activeItems.length,
    visibleQuestIds: activeItems.map((item) => item.id),
    visibleQuestKeys: activeItems.map(questIdentity),
  });
}

export function QuestLogApp({
  branch,
  identity,
  runtime,
  theme: viewerTheme,
}: {
  readonly branch?: string | undefined;
  readonly identity?: string | undefined;
  readonly runtime: QuestLogRuntime;
  readonly theme: ViewerTheme;
}) {
  const renderer = useRenderer();
  const dimensions = useTerminalDimensions();
  const themeRegistry = viewerTheme.registry ?? QUEST_THEMES;
  const [theme, setTheme] = useState(
    () => findQuestTheme(viewerTheme.name, themeRegistry) ?? DENSE_THEME,
  );
  const [snapshot, setSnapshot] = useState<QuestLogSnapshot>({
    currentRepo: null,
    error: null,
    items: [],
    loading: true,
    plan: null,
    refreshing: false,
    signoff: EMPTY_QUEST_LOG_SIGNOFF,
    scope: "all",
  });
  const [interaction, setInteraction] = useState(INITIAL_QUEST_LOG_INTERACTION);
  const [notice, setNotice] = useState(() => initialThemeNotice(viewerTheme.warnings));
  const interactionRef = useRef(INITIAL_QUEST_LOG_INTERACTION);
  const themeRef = useRef(theme);
  themeRef.current = theme;
  const requestThemeSave = useMemo(
    () =>
      createThemeSaver({
        onFailed: (saved, reason) => {
          setNotice(unsavedThemeNotice(saved, reason));
        },
        onSaved: (saved) => {
          setNotice(savedThemeNotice(saved));
        },
        save: viewerTheme.save,
      }),
    [viewerTheme.save],
  );

  useEffect(() => runtime.subscribe(setSnapshot), [runtime]);

  const planAvailable = snapshot.plan !== null;
  const sortMode = snapshot.plan === null ? "flat" : interaction.sortMode;
  const orderedItems = useMemo(
    () => (sortMode === "plan" && snapshot.plan !== null ? snapshot.plan.items : snapshot.items),
    [snapshot.items, snapshot.plan, sortMode],
  );
  const policyItems = useMemo(
    () => visibleQuestLogItems(orderedItems, interaction.showDone),
    [interaction.showDone, orderedItems],
  );
  const hiddenDoneCount = orderedItems.length - policyItems.length;
  const areas = useMemo(() => [undefined, ...areaTabs(policyItems)], [policyItems]);
  const areaKeys = useMemo(() => areas.map(areaTabKey), [areas]);
  const signoffItems = useMemo(
    () => [
      ...snapshot.signoff.groups.flatMap((group) => group.items),
      ...snapshot.signoff.signed.map((history) => history.item),
    ],
    [snapshot.signoff],
  );
  const lens = interaction.lens;
  useEffect(() => {
    runtime.setSignoffActive(lens === "signoff");
    return () => runtime.setSignoffActive(false);
  }, [lens, runtime]);
  const activeAreaKeys = useMemo(() => (lens === "signoff" ? ["all"] : areaKeys), [areaKeys, lens]);
  const activeAreaIndex =
    lens === "signoff" ? 0 : Math.max(0, areaKeys.indexOf(interaction.areaKey));
  const activeArea = areas[activeAreaIndex];
  const visibleItems = useMemo(
    () => itemsForArea(policyItems, activeArea),
    [activeArea, policyItems],
  );
  const activeItems = lens === "signoff" ? signoffItems : visibleItems;
  const activeQuestIds = useMemo(() => activeItems.map((item) => item.id), [activeItems]);
  const activeQuestKeys = useMemo(() => activeItems.map(questIdentity), [activeItems]);
  const activeSelectedIndex = selectedIndexForQuest(activeItems, interaction);
  const current = selectedQuest(activeItems, activeSelectedIndex);
  const currentPr = current?.pr;
  const currentQuestId = current?.id;
  const detailState = useQuestDetail(runtime, current);
  const detail = detailState.detail;
  const geometry = mainPaneGeometry(dimensions.width, dimensions.height);
  const detailMetrics = useMemo(
    () =>
      current === undefined
        ? {
            contentRows: 0,
            headerRows: 0,
            maxOffset: 0,
            showFooter: false,
            viewportRows: 0,
          }
        : detailPaneScrollMetrics(
            current,
            detail,
            geometry.detailWidth,
            geometry.detailRows,
            theme,
            lens === "dev" ? (snapshot.plan?.laneClusters ?? []) : [],
          ),
    [
      current,
      detail,
      geometry.detailRows,
      geometry.detailWidth,
      lens,
      snapshot.plan?.laneClusters,
      theme,
    ],
  );
  const counts = useMemo(() => headerCounts(snapshot.items), [snapshot.items]);

  useEffect(() => {
    const next = reduceReadOnlyInteraction(
      interactionRef.current,
      { name: "", raw: "", sequence: "", shift: false },
      {
        areaCount: activeAreaKeys.length,
        areaKeys: activeAreaKeys,
        detailContentRows: detailMetrics.contentRows,
        detailViewportRows: detailMetrics.viewportRows,
        ...(currentPr === undefined ? {} : { pr: currentPr }),
        questId: currentQuestId,
        visibleCount: activeItems.length,
        visibleQuestIds: activeQuestIds,
        visibleQuestKeys: activeQuestKeys,
      },
    );
    if (
      next.state.areaIndex !== interaction.areaIndex ||
      next.state.areaKey !== interaction.areaKey ||
      next.state.selectedIndex !== interaction.selectedIndex ||
      next.state.selectedQuestId !== interaction.selectedQuestId ||
      next.state.selectedQuestKey !== interaction.selectedQuestKey ||
      next.state.detailScrollOffset !== interaction.detailScrollOffset
    ) {
      interactionRef.current = next.state;
      setInteraction((state) => ({ ...state, ...next.state }));
    }
  }, [
    activeAreaKeys,
    activeItems.length,
    activeQuestIds,
    activeQuestKeys,
    currentPr,
    currentQuestId,
    detailMetrics.contentRows,
    detailMetrics.viewportRows,
    interaction.detailScrollOffset,
    interaction.areaIndex,
    interaction.areaKey,
    interaction.selectedIndex,
    interaction.selectedQuestId,
    interaction.selectedQuestKey,
  ]);

  useKeyboard((key) => {
    const result = keyboardInteractionResult(
      interactionRef.current,
      { name: key.name, raw: key.raw, sequence: key.sequence, shift: key.shift },
      snapshot,
      signoffItems,
      areas,
      areaKeys,
      detailMetrics.contentRows,
      detailMetrics.viewportRows,
    );
    interactionRef.current = result.state;
    setInteraction(result.state);
    switch (result.intent.type) {
      case "none":
        return;
      case "cycle-scope":
        void runtime.cycleScope().then(
          (selection) => {
            const label =
              selection.scope === "current" ? (selection.currentRepo ?? "current") : "all";
            setNotice(`scope: ${label}`);
          },
          () => {
            setNotice("Scope switch unavailable; try again");
          },
        );
        return;
      case "cycle-theme": {
        const next = questThemeAfter(themeRef.current, themeRegistry);
        themeRef.current = next;
        setTheme(next);
        setNotice(`Theme: ${next.name}`);
        requestThemeSave(next);
        return;
      }
      case "toggle-lens":
        setNotice(result.intent.lens === "signoff" ? "Sign-off lens" : "Dev lens");
        return;
      case "notice":
        setNotice(result.intent.message);
        return;
      case "quit":
        renderer.destroy();
        return;
      case "toggle-done":
        setNotice(result.state.showDone ? "Showing done quests" : "Hiding done quests");
        return;
      case "toggle-sort":
        setNotice(result.state.sortMode === "plan" ? "Plan order" : "Flat sort");
        return;
      case "open-evidence":
        openEvidenceWithNotice(
          runtime.openEvidence,
          result.intent.id,
          setNotice,
          result.intent.repository,
        );
        return;
      case "open-pr":
        openPrWithNotice(runtime.openPr, result.intent.url, setNotice);
        return;
    }
  });

  return (
    <QuestThemeContext.Provider value={theme}>
      <ReadOnlyLayout
        branch={branch}
        counts={counts}
        current={current}
        detail={detail}
        detailScrollOffset={interaction.detailScrollOffset}
        hiddenDoneCount={hiddenDoneCount}
        height={dimensions.height}
        identity={identity}
        lens={lens}
        activeAreaIndex={activeAreaIndex}
        activeSelectedIndex={activeSelectedIndex}
        notice={
          snapshot.error ??
          (lens === "signoff" ? snapshot.signoff.error : null) ??
          (detailState.detailStale ? "Detail refresh failed; showing stale data" : notice)
        }
        policyItems={policyItems}
        planAvailable={planAvailable}
        signoff={snapshot.signoff}
        signoffItems={signoffItems}
        signoffSelectedIndex={activeSelectedIndex}
        sortMode={sortMode}
        snapshot={snapshot}
        visibleItems={visibleItems}
        width={dimensions.width}
      />
    </QuestThemeContext.Provider>
  );
}
