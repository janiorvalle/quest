import type { QuestLogSnapshot } from "../services/quest-log-model";

const OSC_TITLE_PREFIX = "\u001b]0;";
const BEL = "\u0007";

export interface TerminalTitleController {
  readonly clear: () => void;
  readonly update: (snapshot: Pick<QuestLogSnapshot, "currentRepo" | "scope">) => void;
}

export interface TerminalTitleControllerOptions {
  readonly isSupported?: () => boolean;
  readonly tmuxPassthrough?: boolean;
  readonly write: (sequence: string) => void;
}

interface TerminalTitleSequenceOptions {
  readonly tmuxPassthrough?: boolean;
}

function safeScopeName(scope: string): string {
  let safeScope = "";
  for (const character of scope) {
    const codePoint = character.codePointAt(0);
    if (codePoint === undefined || codePoint <= 0x1f || (codePoint >= 0x7f && codePoint <= 0x9f)) {
      continue;
    }
    safeScope += character;
  }
  return safeScope;
}

function titleForSnapshot(snapshot: Pick<QuestLogSnapshot, "currentRepo" | "scope">): string {
  const scope = snapshot.scope === "current" ? (snapshot.currentRepo ?? "current") : "all";
  return `quest \u00b7 ${safeScopeName(scope)}`;
}

function titleSequence(title: string): string {
  return `${OSC_TITLE_PREFIX}${title}${BEL}`;
}

export function createTerminalTitleController(
  options: TerminalTitleControllerOptions,
): TerminalTitleController {
  const isSupported = options.isSupported ?? (() => true);
  const sequenceOptions = { tmuxPassthrough: options.tmuxPassthrough ?? false };
  let currentTitle: string | undefined;
  let cleared = false;

  return {
    clear: () => {
      if (cleared || currentTitle === undefined) {
        cleared = true;
        return;
      }
      if (isSupported()) {
        options.write(terminalTitleSequence("", sequenceOptions));
      }
      currentTitle = undefined;
      cleared = true;
    },
    update: (snapshot) => {
      if (cleared) {
        return;
      }
      const nextTitle = titleForSnapshot(snapshot);
      if (nextTitle === currentTitle || !isSupported()) {
        return;
      }
      options.write(terminalTitleSequence(nextTitle, sequenceOptions));
      currentTitle = nextTitle;
    },
  };
}

export function terminalTitleSequence(
  title: string,
  options: TerminalTitleSequenceOptions = {},
): string {
  const sequence = titleSequence(title);
  return options.tmuxPassthrough === true ? `\u001bPtmux;\u001b${sequence}\u001b\\` : sequence;
}

export function terminalTitleForSnapshot(
  snapshot: Pick<QuestLogSnapshot, "currentRepo" | "scope">,
): string {
  return titleForSnapshot(snapshot);
}
