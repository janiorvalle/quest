declare const __QUEST_VERSION__: string;

// The deploy wrapper replaces this fallback with the release literal before bundling Convex.
export const deployedQuestVersion =
  typeof __QUEST_VERSION__ === "string" ? __QUEST_VERSION__ : "0.0.0-dev";
