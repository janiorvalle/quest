export const MAIN_CHROME_ROWS = 8;

export function mainPaneGeometry(
  width: number,
  height: number,
): {
  readonly detailRows: number;
  readonly detailWidth: number;
  readonly direction: "column" | "row";
  readonly listHeight: number | "100%";
  readonly listWidth: number;
  readonly narrow: boolean;
} {
  const narrow = width < 86;
  if (narrow) {
    const listHeight = Math.max(4, Math.floor(Math.max(1, height - MAIN_CHROME_ROWS) * 0.45));
    return {
      detailRows: Math.max(1, height - MAIN_CHROME_ROWS - listHeight - 1),
      detailWidth: width,
      direction: "column",
      listHeight,
      listWidth: width,
      narrow,
    };
  }

  const listWidth = Math.max(1, Math.floor(width * 0.57));
  return {
    detailRows: Math.max(1, height - MAIN_CHROME_ROWS),
    detailWidth: Math.max(1, width - listWidth - 1),
    direction: "row",
    listHeight: "100%",
    listWidth,
    narrow,
  };
}
