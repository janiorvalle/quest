import { readFile } from "node:fs/promises";
import { basename, resolve } from "node:path";

import type { EvidenceFileReader } from "./port";

export function createLocalEvidenceFileReader(): EvidenceFileReader {
  return {
    async read(filePath, workingDirectory) {
      const resolvedPath = resolve(workingDirectory, filePath);
      return {
        bytes: await readFile(resolvedPath),
        filename: basename(resolvedPath),
      };
    },
  };
}
