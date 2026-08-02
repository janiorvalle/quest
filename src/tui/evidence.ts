export type EvidenceOpener = (id: number) => Promise<string>;
export type NoticeSetter = (notice: string) => void;

function errorDetail(error: unknown): string {
  const detail = error instanceof Error ? error.message : String(error);
  return detail === "" ? "unknown opener error" : detail;
}

export function evidenceOpenFailureNotice(error: unknown): string {
  return `Could not open evidence: ${errorDetail(error)}. Check your default app and try again.`;
}

export function openEvidenceWithNotice(
  openEvidence: EvidenceOpener,
  id: number,
  setNotice: NoticeSetter,
): void {
  void openEvidence(id)
    .then(setNotice)
    .catch((error: unknown) => setNotice(evidenceOpenFailureNotice(error)));
}

export function openedEvidenceNotice(filenames: readonly string[]): string {
  if (filenames.length === 0) {
    return "No evidence files were opened";
  }
  const noun = filenames.length === 1 ? "file" : "files";
  return `Opened ${filenames.length} evidence ${noun}: ${filenames.join(", ")}`;
}
