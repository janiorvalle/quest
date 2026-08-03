import {
  DENSE_THEME,
  findQuestTheme,
  QUEST_THEMES,
  type QuestTheme,
  questThemeNames,
} from "./theme";

export const UNKNOWN_THEME_CODE = "QUEST_UNKNOWN_THEME";

export class UnknownThemeError extends Error {
  readonly code = UNKNOWN_THEME_CODE;

  constructor(message: string) {
    super(message);
    this.name = "UnknownThemeError";
  }
}

export interface ThemeSelectionSources {
  readonly configTheme?: string | undefined;
  readonly environmentTheme?: string | undefined;
  readonly flagTheme?: string | undefined;
  readonly themes?: readonly QuestTheme[];
}

export interface ThemeSelection {
  readonly theme: QuestTheme;
  readonly warnings: readonly string[];
}

/** What the viewer is handed at launch: the theme it starts on, and how to remember a new one. */
export interface ViewerTheme {
  readonly name: string;
  readonly registry?: readonly QuestTheme[];
  readonly save: (themeName: string) => Promise<void>;
  readonly warnings: readonly string[];
}

function validThemeList(themes: readonly QuestTheme[]): string {
  return questThemeNames(themes).join(", ");
}

function requestedTheme(
  name: string,
  themes: readonly QuestTheme[],
  unknown: (valid: string) => string,
): QuestTheme {
  const theme = findQuestTheme(name, themes);
  if (theme === undefined) {
    throw new UnknownThemeError(`[${UNKNOWN_THEME_CODE}] ${unknown(validThemeList(themes))}`);
  }
  return theme;
}

function flagTheme(name: string, themes: readonly QuestTheme[]): QuestTheme {
  return requestedTheme(
    name,
    themes,
    (valid) =>
      `--theme ${name} is not a theme this quest build knows. Valid themes: ${valid}. Rerun with --theme ${DENSE_THEME.name}.`,
  );
}

function environmentTheme(name: string, themes: readonly QuestTheme[]): QuestTheme {
  return requestedTheme(
    name,
    themes,
    (valid) =>
      `QUEST_THEME=${name} is not a theme this quest build knows. Valid themes: ${valid}. Set QUEST_THEME=${DENSE_THEME.name} or unset it to use the default.`,
  );
}

/**
 * A config file outlives the binary that reads it: a name written by a newer quest must not brick
 * an older viewer, so config is the one source that warns and falls back instead of failing.
 *
 * This warning is read by a person in the viewer's one-line notice strip, not by an agent parsing
 * stderr, so it stays short enough to survive that strip and skips the error code the flag and
 * environment messages carry.
 */
function configTheme(name: string, themes: readonly QuestTheme[]): ThemeSelection {
  const theme = findQuestTheme(name, themes);
  if (theme !== undefined) {
    return { theme, warnings: [] };
  }
  return {
    theme: DENSE_THEME,
    warnings: [
      `Config theme "${name}" is not in this quest build; showing ${DENSE_THEME.name}. Press t to pick one.`,
    ],
  };
}

export function selectQuestTheme(sources: ThemeSelectionSources): ThemeSelection {
  const themes = sources.themes ?? QUEST_THEMES;
  if (sources.flagTheme !== undefined) {
    return { theme: flagTheme(sources.flagTheme, themes), warnings: [] };
  }
  if (sources.environmentTheme !== undefined) {
    return { theme: environmentTheme(sources.environmentTheme, themes), warnings: [] };
  }
  if (sources.configTheme !== undefined) {
    return configTheme(sources.configTheme, themes);
  }
  return { theme: DENSE_THEME, warnings: [] };
}
