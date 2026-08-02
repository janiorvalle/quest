import { useKeyboard, useRenderer, useTerminalDimensions } from "@opentui/react";
import { useEffect, useMemo, useRef, useState } from "react";

import type { QuestLogItem, QuestLogRuntime, QuestLogSnapshot } from "../services/quest-log-model";
import {
  AppHeader,
  type AreaTab,
  areaLabel,
  areaTabKey,
  DetailPane,
  FooterKeymap,
  type HeaderCounts,
  HorizontalRule,
  QuestListPane,
  StatusRow,
  TabsRow,
} from "./components";
import { openEvidenceWithNotice } from "./evidence";
import {
  INITIAL_QUEST_LOG_INTERACTION,
  type QuestLogInteractionState,
  reduceReadOnlyInteraction,
} from "./interaction";
import { MAIN_CHROME_ROWS, mainPaneGeometry } from "./layout";
import { openPrWithNotice } from "./pr";
import { themeByName } from "./theme";
import { QuestThemeContext, useQuestTheme } from "./theme-context";

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

function selectedIndexForQuest(
  items: readonly QuestLogItem[],
  interaction: QuestLogInteractionState,
): number {
  if (items.length === 0) {
    return 0;
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
  const detailKey = current === undefined ? "" : `${current.id}@${current.updatedAt}`;

  useEffect(() => {
    if (detailKey === "") {
      setDetail(null);
      return;
    }
    setDetail(null);
    const separator = detailKey.indexOf("@");
    const id = Number(detailKey.slice(0, separator));
    let cancelled = false;
    runtime.loadDetail(id).then(
      (value) => {
        if (!cancelled) {
          setDetail(value);
        }
      },
      () => {
        if (!cancelled) {
          setDetail(null);
        }
      },
    );
    return () => {
      cancelled = true;
    };
  }, [detailKey, runtime]);

  return detail;
}

function ReadOnlyLayout({
  branch,
  counts,
  current,
  detail,
  hiddenDoneCount,
  identity,
  activeAreaIndex,
  activeSelectedIndex,
  notice,
  policyItems,
  runtime,
  snapshot,
  visibleItems,
  width,
  height,
}: {
  readonly branch: string | undefined;
  readonly counts: HeaderCounts;
  readonly current: QuestLogItem | undefined;
  readonly detail: Awaited<ReturnType<QuestLogRuntime["loadDetail"]>> | null;
  readonly hiddenDoneCount: number;
  readonly identity: string | undefined;
  readonly activeAreaIndex: number;
  readonly activeSelectedIndex: number;
  readonly notice: string;
  readonly policyItems: readonly QuestLogItem[];
  readonly runtime: QuestLogRuntime;
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
      <AppHeader branch={branch} counts={counts} identity={identity} repo={scope} width={width} />
      <HorizontalRule width={width} />
      <TabsRow activeIndex={activeAreaIndex} scope={scope} tabs={tabs} width={width} />
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
          <QuestListPane
            height={geometry.narrow ? listHeight : mainHeight}
            hiddenDoneCount={hiddenDoneCount}
            items={visibleItems}
            loading={snapshot.loading}
            paneWidth={geometry.listWidth}
            selectedIndex={activeSelectedIndex}
            terminalWidth={width}
            totalCount={policyItems.length}
          />
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
            paneWidth={geometry.detailWidth}
            rows={geometry.detailRows}
          />
        </box>
      </box>
      <HorizontalRule width={width} />
      <StatusRow notice={notice} pollIntervalMs={runtime.pollIntervalMs} width={width} />
      <FooterKeymap />
    </box>
  );
}

export function QuestLogApp({
  branch,
  identity,
  runtime,
  themeName,
}: {
  readonly branch?: string | undefined;
  readonly identity?: string | undefined;
  readonly runtime: QuestLogRuntime;
  readonly themeName?: string | undefined;
}) {
  const renderer = useRenderer();
  const dimensions = useTerminalDimensions();
  const [snapshot, setSnapshot] = useState<QuestLogSnapshot>({
    currentRepo: null,
    items: [],
    loading: true,
    scope: "all",
  });
  const [interaction, setInteraction] = useState(INITIAL_QUEST_LOG_INTERACTION);
  const [notice, setNotice] = useState("Watching for quest changes");
  const interactionRef = useRef(INITIAL_QUEST_LOG_INTERACTION);

  useEffect(() => runtime.subscribe(setSnapshot), [runtime]);

  const policyItems = useMemo(
    () => visibleQuestLogItems(snapshot.items, interaction.showDone),
    [interaction.showDone, snapshot.items],
  );
  const hiddenDoneCount = snapshot.items.length - policyItems.length;
  const areas = useMemo(() => [undefined, ...areaTabs(policyItems)], [policyItems]);
  const areaKeys = useMemo(() => areas.map(areaTabKey), [areas]);
  const activeAreaIndex = Math.max(0, areaKeys.indexOf(interaction.areaKey));
  const activeArea = areas[activeAreaIndex];
  const visibleItems = useMemo(
    () => itemsForArea(policyItems, activeArea),
    [activeArea, policyItems],
  );
  const visibleQuestIds = useMemo(() => visibleItems.map((item) => item.id), [visibleItems]);
  const activeSelectedIndex = selectedIndexForQuest(visibleItems, interaction);
  const current = selectedQuest(visibleItems, activeSelectedIndex);
  const currentPr = current?.pr;
  const currentQuestId = current?.id;
  const detail = useQuestDetail(runtime, current);
  const counts = useMemo(() => headerCounts(snapshot.items), [snapshot.items]);

  useEffect(() => {
    const next = reduceReadOnlyInteraction(
      interactionRef.current,
      { name: "", raw: "", sequence: "", shift: false },
      {
        areaCount: areas.length,
        areaKeys,
        ...(currentPr === undefined ? {} : { pr: currentPr }),
        questId: currentQuestId,
        visibleCount: visibleItems.length,
        visibleQuestIds,
      },
    );
    if (
      next.state.areaIndex !== interaction.areaIndex ||
      next.state.areaKey !== interaction.areaKey ||
      next.state.selectedIndex !== interaction.selectedIndex ||
      next.state.selectedQuestId !== interaction.selectedQuestId
    ) {
      interactionRef.current = next.state;
      setInteraction((state) => ({ ...state, ...next.state }));
    }
  }, [
    areas.length,
    areaKeys,
    currentPr,
    currentQuestId,
    interaction.areaIndex,
    interaction.areaKey,
    interaction.selectedIndex,
    interaction.selectedQuestId,
    visibleItems.length,
    visibleQuestIds,
  ]);

  useKeyboard((key) => {
    const active = interactionRef.current;
    const activeAreaIndex = Math.max(0, areaKeys.indexOf(active.areaKey));
    const activeArea = areas[activeAreaIndex];
    const activeItems = itemsForArea(
      visibleQuestLogItems(snapshot.items, active.showDone),
      activeArea,
    );
    const activeQuest = selectedQuest(activeItems, selectedIndexForQuest(activeItems, active));
    const result = reduceReadOnlyInteraction(
      active,
      { name: key.name, raw: key.raw, sequence: key.sequence, shift: key.shift },
      {
        areaCount: areas.length,
        areaKeys,
        ...(activeQuest === undefined ? {} : { pr: activeQuest.pr }),
        questId: activeQuest?.id,
        visibleCount: activeItems.length,
        visibleQuestIds: activeItems.map((item) => item.id),
      },
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
      case "notice":
        setNotice(result.intent.message);
        return;
      case "quit":
        renderer.destroy();
        return;
      case "toggle-done":
        setNotice(result.state.showDone ? "Showing done quests" : "Hiding done quests");
        return;
      case "open-evidence":
        openEvidenceWithNotice(runtime.openEvidence, result.intent.id, setNotice);
        return;
      case "open-pr":
        openPrWithNotice(runtime.openPr, result.intent.url, setNotice);
        return;
    }
  });

  return (
    <QuestThemeContext.Provider value={themeByName(themeName)}>
      <ReadOnlyLayout
        branch={branch}
        counts={counts}
        current={current}
        detail={detail}
        hiddenDoneCount={hiddenDoneCount}
        height={dimensions.height}
        identity={identity}
        activeAreaIndex={activeAreaIndex}
        activeSelectedIndex={activeSelectedIndex}
        notice={notice}
        policyItems={policyItems}
        runtime={runtime}
        snapshot={snapshot}
        visibleItems={visibleItems}
        width={dimensions.width}
      />
    </QuestThemeContext.Provider>
  );
}
