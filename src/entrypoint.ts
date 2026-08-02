import { execFile } from "node:child_process";

import { runQuestMain } from "./cli/main";
import type { FutureTuiContext } from "./cli/program";
import { createEvidenceMaterializer } from "./evidence";
import { createQuestLogRuntime, materializeQuestEvidence, showQuestDetail } from "./services";
import { launchQuestLog } from "./tui";
import { openedEvidenceNotice } from "./tui/evidence";
import { openedPrNotice, parseHttpUrl } from "./tui/pr";

function currentGitBranch(workingDirectory: string): Promise<string | undefined> {
  return new Promise((resolve) => {
    execFile(
      "git",
      ["branch", "--show-current"],
      { cwd: workingDirectory, encoding: "utf8" },
      (error, stdout) => {
        const branch = stdout.trim();
        resolve(error === null && branch !== "" ? branch : undefined);
      },
    );
  });
}

const launchReadOnlyViewer = async (context: FutureTuiContext): Promise<void> => {
  const branch = await currentGitBranch(context.workingDirectory);
  const runtime = createQuestLogRuntime({
    initialScope: context.scope,
    openEvidence: async (id) => {
      const detail = await showQuestDetail(context.ports.questStore, { repo: null }, id);
      if (detail.evidence.length === 0) {
        return `Quest ${id} has no evidence`;
      }
      const materialized = await materializeQuestEvidence(
        context.ports.blobStore,
        detail.evidence,
        createEvidenceMaterializer,
      );
      try {
        for (const file of materialized.files) {
          await context.viewer.openEvidence(file.path);
        }
        return openedEvidenceNotice(materialized.files.map((file) => file.filename));
      } catch (error) {
        await materialized.cleanup();
        throw error;
      }
    },
    openPr: async (url) => {
      const safeUrl = parseHttpUrl(url);
      if (safeUrl === undefined) {
        throw new Error("PR URL must use the http or https scheme");
      }
      await context.viewer.openUrl(safeUrl);
      return openedPrNotice(safeUrl);
    },
    store: context.ports.questStore,
  });
  await launchQuestLog(runtime, {
    ...(branch === undefined ? {} : { branch }),
    ...(context.identity === undefined ? {} : { identity: context.identity }),
    ...(context.theme === undefined ? {} : { themeName: context.theme }),
  });
};

process.exitCode = await runQuestMain(launchReadOnlyViewer);
