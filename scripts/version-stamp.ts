export function questVersionDefine(version: string): { readonly __QUEST_VERSION__: string } {
  return { __QUEST_VERSION__: JSON.stringify(version) };
}

export function generatedConvexVersionSource(version: string): string {
  return `const __QUEST_VERSION__ = ${JSON.stringify(version)};\nexport const deployedQuestVersion = __QUEST_VERSION__;\n`;
}
