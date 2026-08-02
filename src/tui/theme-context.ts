import { createContext, useContext } from "react";

import { DENSE_THEME, type QuestTheme } from "./theme";

export const QuestThemeContext = createContext<QuestTheme>(DENSE_THEME);

export function useQuestTheme(): QuestTheme {
  return useContext(QuestThemeContext);
}
