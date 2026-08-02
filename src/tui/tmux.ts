import { execFile } from "node:child_process";

export interface TmuxPassthroughSetup {
  readonly enabled: boolean;
  readonly restore: () => Promise<void>;
}

export interface PrepareTmuxPassthroughOptions {
  readonly environment?: Readonly<Record<string, string | undefined>>;
  readonly run?: (argumentsList: readonly string[]) => Promise<string>;
}

function runTmux(argumentsList: readonly string[]): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile("tmux", [...argumentsList], { encoding: "utf8" }, (error, stdout) => {
      if (error !== null) {
        reject(error);
        return;
      }
      resolve(stdout);
    });
  });
}

function disabledSetup(): TmuxPassthroughSetup {
  return {
    enabled: false,
    restore: async () => {},
  };
}

export async function prepareTmuxPassthrough(
  options: PrepareTmuxPassthroughOptions = {},
): Promise<TmuxPassthroughSetup> {
  const environment = options.environment ?? process.env;
  const tmuxPane = environment["TMUX_PANE"];
  if (environment["TMUX"] === undefined || tmuxPane === undefined) {
    return disabledSetup();
  }

  const run = options.run ?? runTmux;
  const optionArguments = ["-p", "-t", tmuxPane, "allow-passthrough"];
  try {
    const previous = (
      await run(["show-options", "-p", "-qv", "-t", tmuxPane, "allow-passthrough"])
    ).trim();
    await run(["set-option", ...optionArguments, "on"]);
    let restored = false;
    return {
      enabled: true,
      restore: async () => {
        if (restored) {
          return;
        }
        restored = true;
        try {
          await run(
            previous === ""
              ? ["set-option", "-p", "-u", "-t", tmuxPane, "allow-passthrough"]
              : ["set-option", ...optionArguments, previous],
          );
        } catch {
          // The pane may already be gone; title cleanup should not mask viewer shutdown.
        }
      },
    };
  } catch {
    return disabledSetup();
  }
}
