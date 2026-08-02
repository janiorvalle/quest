import type { QuestStatus } from "../schema";

export interface QuestThemePalette {
  readonly accent: string;
  readonly background: string;
  readonly borderActive: string;
  readonly borderIdle: string;
  readonly hint: string;
  readonly lane: string;
  readonly sectionLabel: string;
  readonly selection: string;
  readonly selectionInk: string;
  readonly stripe: string;
  readonly surface: string;
  readonly textBright: string;
  readonly textDim: string;
  readonly textMuted: string;
  readonly textPrimary: string;
  readonly textSecondary: string;
  readonly warn: string;
}

export interface QuestThemeStatus {
  readonly color: string;
  readonly label: string;
}

export interface QuestThemeGlyphs {
  readonly arrow: string;
  readonly blocked: string;
  readonly chainComplete: string;
  readonly chainOther: string;
  readonly chainTurnedIn: string;
  readonly evidenceComplete: string;
  readonly evidencePending: string;
  readonly laneEnd: string;
  readonly laneStart: string;
  readonly priority: string;
  readonly ruleHorizontal: string;
  readonly ruleVertical: string;
  readonly scrollbarFull: string;
  readonly scrollbarTrack: string;
  readonly selection: string;
  readonly watching: string;
}

export interface QuestThemeLabels {
  readonly activity: string;
  readonly appTitle: string;
  readonly chain: string;
  readonly chainDuplicateOf: string;
  readonly chainRequires: string;
  readonly chainUnlocks: string;
  readonly description: string;
  readonly evidence: string;
  readonly evidenceEmpty: string;
  readonly statusPhrase: Readonly<Record<QuestStatus, string>>;
  readonly statsTitle: string;
  readonly verdict: string;
}

export type QuestThemeBorder = "double" | "heavy" | "rounded" | "single";
export type QuestThemeFooterStyle = "keycap" | "plain";
export type QuestThemeListStyle = "columns" | "simple" | "zoned";
export type QuestThemeTabStyle = "block" | "chip";

export interface QuestThemeStructure {
  readonly badge: string | null;
  readonly footerKeys: QuestThemeFooterStyle;
  readonly list: QuestThemeListStyle;
  readonly progress: boolean;
  readonly tabs: QuestThemeTabStyle;
}

export interface QuestTheme {
  readonly border: QuestThemeBorder;
  readonly structure: QuestThemeStructure;
  readonly glyphs: QuestThemeGlyphs;
  readonly labels: QuestThemeLabels;
  readonly name: string;
  readonly palette: QuestThemePalette;
  readonly status: Readonly<Record<QuestStatus, QuestThemeStatus>>;
}

export const DENSE_THEME: QuestTheme = {
  border: "single",
  structure: { badge: null, footerKeys: "plain", list: "columns", progress: false, tabs: "block" },
  glyphs: {
    arrow: "━━▶",
    blocked: "⛓",
    chainComplete: "✓",
    chainOther: "·",
    chainTurnedIn: "◆",
    evidenceComplete: "✓",
    evidencePending: "◌",
    laneEnd: "┘",
    laneStart: "┐",
    priority: "▲",
    ruleHorizontal: "─",
    ruleVertical: "│",
    scrollbarFull: "█",
    scrollbarTrack: "░",
    selection: "",
    watching: "●",
  },
  labels: {
    activity: "RECENT EVENTS",
    appTitle: "quest",
    chain: "CHAIN",
    chainDuplicateOf: "dup",
    chainRequires: "req",
    chainUnlocks: "unlocks",
    description: "DESCRIPTION",
    evidence: "EVIDENCE",
    evidenceEmpty: "—",
    statusPhrase: {
      accepted: "in progress",
      complete: "verified",
      dropped: "closed",
      open: "needs triage",
      ready: "unclaimed",
      turned_in: "awaiting verification",
    },
    statsTitle: "quest · stats",
    verdict: "VERDICT",
  },
  name: "dense",
  palette: {
    accent: "#62c4c9",
    background: "#0b0f12",
    borderActive: "#3d5866",
    borderIdle: "#24313a",
    hint: "#62c4c9",
    lane: "#bc8cff",
    sectionLabel: "#7fa3b8",
    selection: "#c9d4d9",
    selectionInk: "#0b0f12",
    stripe: "#0d1216",
    surface: "#0e1418",
    textBright: "#c9d4d9",
    textDim: "#37444b",
    textMuted: "#5f7078",
    textPrimary: "#c9d4d9",
    textSecondary: "#9fb2ba",
    warn: "#e3c05c",
  },
  status: {
    accepted: { color: "#7fa3b8", label: "◐ active" },
    complete: { color: "#7bc96f", label: "✓ complete" },
    dropped: { color: "#37444b", label: "✕ dropped" },
    open: { color: "#d1706b", label: "○ open" },
    ready: { color: "#62c4c9", label: "● ready" },
    turned_in: { color: "#e3c05c", label: "◆ review" },
  },
};

export const QUEST_THEMES: readonly QuestTheme[] = [DENSE_THEME];

export function themeByName(name: string | undefined): QuestTheme {
  if (name === undefined) {
    return DENSE_THEME;
  }
  return QUEST_THEMES.find((theme) => theme.name === name) ?? DENSE_THEME;
}
