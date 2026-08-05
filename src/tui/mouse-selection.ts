export const INVALID_TUI_MOUSE_CODE = "QUEST_INVALID_TUI_MOUSE";

export class InvalidTuiMouseError extends Error {
  readonly code = INVALID_TUI_MOUSE_CODE;

  constructor(value: string) {
    super(
      `[${INVALID_TUI_MOUSE_CODE}] QUEST_TUI_MOUSE=${value} is invalid. Expected true or false. Set QUEST_TUI_MOUSE=false to restore native terminal mouse behavior, or unset it to use [tui] mouse and the default.`,
    );
    this.name = "InvalidTuiMouseError";
  }
}

export interface MouseSelectionSources {
  readonly configMouse?: boolean | undefined;
  readonly environmentMouse?: string | undefined;
}

function environmentMouse(value: string): boolean {
  if (value === "true") {
    return true;
  }
  if (value === "false") {
    return false;
  }
  throw new InvalidTuiMouseError(value);
}

export function selectQuestMouse(sources: MouseSelectionSources): boolean {
  if (sources.environmentMouse !== undefined) {
    return environmentMouse(sources.environmentMouse);
  }
  return sources.configMouse ?? true;
}
