import type { QuestTheme } from "./theme";

export interface ThemeSaverPorts {
  readonly onFailed: (theme: QuestTheme, reason: string) => void;
  readonly onSaved: (theme: QuestTheme) => void;
  readonly save: (themeName: string) => Promise<void>;
}

export type ThemeSaveRequest = (theme: QuestTheme) => void;

function failureReason(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * Keeps the saved theme in step with the one on screen when keypresses outrun the disk.
 *
 * Two rules do that. Writes never overlap, so they land in the order they were requested rather
 * than the order they happen to finish. And a choice made while a write is in flight replaces any
 * other waiting choice, so a burst of presses costs one more write, not one write per press.
 *
 * Outcomes are reported for the newest request only, counted rather than compared by name — the
 * same theme can be chosen twice, and an older attempt at that name must not narrate a newer one.
 */
export function createThemeSaver(ports: ThemeSaverPorts): ThemeSaveRequest {
  let requested = 0;
  let pending: { readonly generation: number; readonly theme: QuestTheme } | undefined;
  let writing = false;

  async function drainPending(): Promise<void> {
    while (pending !== undefined) {
      const current = pending;
      pending = undefined;
      try {
        await ports.save(current.theme.name);
        if (requested === current.generation) {
          ports.onSaved(current.theme);
        }
      } catch (error: unknown) {
        if (requested === current.generation) {
          ports.onFailed(current.theme, failureReason(error));
        }
      }
    }
    writing = false;
  }

  return (theme) => {
    requested += 1;
    pending = { generation: requested, theme };
    if (writing) {
      return;
    }
    writing = true;
    void drainPending();
  };
}
