import agentMetadata from "../../.agents/skills/quest/agents/openai.yaml" with { type: "text" };
import skillMarkdown from "../../.agents/skills/quest/SKILL.md" with { type: "text" };

export interface BundledSkillFile {
  readonly content: string;
  readonly relativePath: string;
}

export const bundledSkillFiles: readonly BundledSkillFile[] = [
  { content: skillMarkdown, relativePath: "SKILL.md" },
  { content: agentMetadata, relativePath: "agents/openai.yaml" },
];

export const bundledSkillMarkdown = skillMarkdown;
