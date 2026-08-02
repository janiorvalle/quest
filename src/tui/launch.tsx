import { type CliRenderer, createCliRenderer } from "@opentui/core";
import { createRoot } from "@opentui/react";

import type { QuestLogRuntime } from "../services/quest-log-model";
import { QuestLogApp } from "./quest-log";
import { createTerminalTitleController } from "./terminal-title";
import { prepareTmuxPassthrough } from "./tmux";

export async function launchQuestLog(
  runtime: QuestLogRuntime,
  options: {
    readonly branch?: string | undefined;
    readonly identity?: string | undefined;
    readonly themeName?: string | undefined;
  } = {},
): Promise<void> {
  const tmuxPassthrough = await prepareTmuxPassthrough();
  const stdout = process.stdout;
  const terminalTitle = createTerminalTitleController({
    isSupported: () => stdout.isTTY === true,
    tmuxPassthrough: tmuxPassthrough.enabled,
    write: (sequence) => {
      stdout.write(sequence);
    },
  });
  let unsubscribeTitle: (() => void) | undefined;
  let renderer: CliRenderer | undefined;
  let finish: (() => void) | undefined;
  const finished = new Promise<void>((resolve) => {
    finish = resolve;
  });

  try {
    await runtime.start();
    unsubscribeTitle = runtime.subscribe(terminalTitle.update);
    renderer = await createCliRenderer({
      clearOnShutdown: true,
      exitOnCtrlC: true,
      onDestroy: () => {
        finish?.();
      },
      screenMode: "alternate-screen",
    });
    createRoot(renderer).render(
      <QuestLogApp
        branch={options.branch}
        identity={options.identity}
        runtime={runtime}
        themeName={options.themeName}
      />,
    );
    await finished;
  } finally {
    try {
      unsubscribeTitle?.();
      terminalTitle.clear();
      renderer?.destroy();
      await runtime.stop();
    } finally {
      await tmuxPassthrough.restore();
    }
  }
}
