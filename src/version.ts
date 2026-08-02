declare const __QUEST_VERSION__: string;

export const applicationVersion =
  typeof __QUEST_VERSION__ === "string" ? __QUEST_VERSION__ : "0.0.0-dev";
