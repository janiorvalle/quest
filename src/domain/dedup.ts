import type { Quest } from "../schema";

type DedupText = Pick<Quest, "title" | "description">;

export function scoreDedupCandidate(subject: DedupText, candidate: DedupText): number {
  const titleScore = tokenSimilarity(subject.title, candidate.title);
  const subjectDescription = normalize(subject.description);
  const candidateDescription = normalize(candidate.description);

  if (subjectDescription.length === 0 || candidateDescription.length === 0) {
    return titleScore;
  }

  const descriptionScore = tokenSimilarity(subjectDescription, candidateDescription);
  return roundScore(titleScore * 0.7 + descriptionScore * 0.3);
}

function tokenSimilarity(left: string, right: string): number {
  const leftTokens = new Set(normalize(left).split(" ").filter(Boolean));
  const rightTokens = new Set(normalize(right).split(" ").filter(Boolean));
  if (leftTokens.size === 0 || rightTokens.size === 0) {
    return 0;
  }

  let intersectionSize = 0;
  for (const token of leftTokens) {
    if (rightTokens.has(token)) {
      intersectionSize += 1;
    }
  }

  return roundScore(intersectionSize / (leftTokens.size + rightTokens.size - intersectionSize));
}

function normalize(value: string): string {
  return value
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .trim();
}

function roundScore(value: number): number {
  return Math.round(value * 10_000) / 10_000;
}
