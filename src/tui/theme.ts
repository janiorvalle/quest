import type { QuestStatus } from "../schema";

export interface QuestThemePalette {
  readonly accent: string;
  readonly background: string;
  readonly borderActive: string;
  readonly borderIdle: string;
  readonly hint: string;
  readonly lane: string;
  readonly pullRequest: string;
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
  readonly glyph: string;
  readonly label: string;
}

/**
 * Blocked is a computed state rather than a stored status, so it names its own glyph and word.
 * It borrows its color from the dimmed row it always appears on.
 */
export interface QuestThemeBlockedStatus {
  readonly glyph: string;
  readonly label: string;
}

export type QuestPriority = 1 | 2 | 3;

export interface QuestThemeGlyphs {
  readonly arrow: string;
  readonly blockedFlag: string;
  readonly chainComplete: string;
  readonly chainOther: string;
  readonly chainTurnedIn: string;
  readonly evidenceComplete: string;
  readonly evidencePending: string;
  readonly laneEnd: string;
  readonly laneStart: string;
  readonly pullRequest: string;
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
  readonly blockedStatus: QuestThemeBlockedStatus;
  readonly border: QuestThemeBorder;
  readonly structure: QuestThemeStructure;
  readonly glyphs: QuestThemeGlyphs;
  readonly labels: QuestThemeLabels;
  readonly name: string;
  readonly palette: QuestThemePalette;
  readonly priorityInk: Readonly<Record<QuestPriority, string>>;
  readonly status: Readonly<Record<QuestStatus, QuestThemeStatus>>;
}

/** The status column reads "<glyph> <word>" everywhere it appears. */
export function questStatusText(status: QuestThemeStatus): string {
  return `${status.glyph} ${status.label}`;
}

/** Priorities are 1–3 by schema; anything else came from data we did not write, so it renders lowest. */
export function questPriorityInk(theme: QuestTheme, priority: number): string {
  return priority === 1 || priority === 2 ? theme.priorityInk[priority] : theme.priorityInk[3];
}

export const DENSE_THEME: QuestTheme = {
  blockedStatus: { glyph: "○", label: "blocked" },
  border: "single",
  structure: { badge: null, footerKeys: "plain", list: "columns", progress: false, tabs: "block" },
  glyphs: {
    arrow: "━━▶",
    blockedFlag: "⛓",
    chainComplete: "✓",
    chainOther: "·",
    chainTurnedIn: "◆",
    evidenceComplete: "✓",
    evidencePending: "◌",
    laneEnd: "┘",
    laneStart: "┐",
    pullRequest: "↗",
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
    pullRequest: "#e3c05c",
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
  priorityInk: { 1: "#d1706b", 2: "#5f7078", 3: "#5f7078" },
  status: {
    accepted: { color: "#7fa3b8", glyph: "◐", label: "active" },
    complete: { color: "#7bc96f", glyph: "✓", label: "complete" },
    dropped: { color: "#37444b", glyph: "✕", label: "dropped" },
    open: { color: "#d1706b", glyph: "○", label: "open" },
    ready: { color: "#62c4c9", glyph: "●", label: "ready" },
    turned_in: { color: "#e3c05c", glyph: "◆", label: "review" },
  },
};

/**
 * The quest-log look. Every status glyph is single-cell — ⚔ (U+2694) advances exactly one column in
 * tmux, the same as the ⛓ dense already ships — so the columns land where dense lands them.
 * Layout, labels and structure are dense's; only the palette, the glyphs and the priority ink move.
 */
export const TAVERN_THEME: QuestTheme = {
  ...DENSE_THEME,
  blockedStatus: { glyph: "!", label: "blocked" },
  name: "tavern",
  palette: {
    accent: "#e8b04a",
    background: "#241a10",
    borderActive: "#684e2e",
    borderIdle: "#3d2e1b",
    hint: "#e8b04a",
    lane: "#c98bde",
    pullRequest: "#e8b04a",
    sectionLabel: "#8a7448",
    selection: "#59431c",
    selectionInk: "#ffd786",
    stripe: "#281d12",
    surface: "#2e2214",
    textBright: "#e3cfa2",
    textDim: "#8a7d68",
    textMuted: "#a08a5f",
    textPrimary: "#e3cfa2",
    textSecondary: "#c1ac80",
    warn: "#c9973f",
  },
  priorityInk: { 1: "#ff8000", 2: "#2f8be6", 3: "#1eff00" },
  status: {
    accepted: { color: "#e8b04a", glyph: "⚔", label: "active" },
    complete: { color: "#a08a5f", glyph: "✓", label: "complete" },
    dropped: { color: "#8a7d68", glyph: "✕", label: "dropped" },
    open: { color: "#c9973f", glyph: "○", label: "open" },
    ready: { color: "#ffd100", glyph: "!", label: "ready" },
    turned_in: { color: "#ffd100", glyph: "?", label: "review" },
  },
};

/**
 * The registry. A new theme ships by adding its QuestTheme object here — selection, the t key,
 * persistence, and the error messages all read this list, so nothing else has to change.
 */
export const QUEST_THEMES: readonly QuestTheme[] = [DENSE_THEME, TAVERN_THEME];

export function questThemeNames(themes: readonly QuestTheme[] = QUEST_THEMES): readonly string[] {
  return themes.map((theme) => theme.name);
}

export function findQuestTheme(
  name: string,
  themes: readonly QuestTheme[] = QUEST_THEMES,
): QuestTheme | undefined {
  return themes.find((theme) => theme.name === name);
}

export function questThemeAfter(
  current: QuestTheme,
  themes: readonly QuestTheme[] = QUEST_THEMES,
): QuestTheme {
  const index = themes.findIndex((theme) => theme.name === current.name);
  return themes[(index + 1) % themes.length] ?? current;
}
