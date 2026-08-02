export type PrOpener = (url: string) => Promise<string>;
export type NoticeSetter = (notice: string) => void;

export function parseHttpUrl(value: string): string | undefined {
  try {
    const url = new URL(value);
    return url.protocol === "http:" || url.protocol === "https:" ? url.href : undefined;
  } catch {
    return undefined;
  }
}

function errorDetail(error: unknown): string {
  const detail = error instanceof Error ? error.message : String(error);
  return detail === "" ? "unknown opener error" : detail;
}

export function prOpenFailureNotice(error: unknown): string {
  return `Could not open PR: ${errorDetail(error)}. Check your default app and try again.`;
}

export function openedPrNotice(url: string): string {
  return `Opened PR in browser: ${url}`;
}

export function openPrWithNotice(openPr: PrOpener, url: string, setNotice: NoticeSetter): void {
  void openPr(url)
    .then(setNotice)
    .catch((error: unknown) => setNotice(prOpenFailureNotice(error)));
}
