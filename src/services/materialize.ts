import type { EvidenceMaterializer, MaterializedEvidenceFile } from "../evidence";
import type { Evidence } from "../schema";
import type { BlobStore } from "../store";

export interface MaterializedQuestEvidenceFile extends MaterializedEvidenceFile {
  readonly evidence_id: number;
}

export interface MaterializedQuestEvidence {
  readonly cleanup: () => Promise<void>;
  readonly directory: string;
  readonly files: readonly MaterializedQuestEvidenceFile[];
}

export type EvidenceMaterializerFactory = () => Promise<EvidenceMaterializer>;

export async function materializeQuestEvidence(
  blobStore: BlobStore,
  evidence: readonly Evidence[],
  createMaterializer: EvidenceMaterializerFactory,
  repository?: string,
): Promise<MaterializedQuestEvidence> {
  const materializer = await createMaterializer();
  try {
    const files: MaterializedQuestEvidenceFile[] = [];
    for (const item of evidence) {
      const bytes = await blobStore.get(item.sha256, repository);
      if (bytes === null) {
        throw new Error(`evidence ${item.id} (${item.filename}) is missing blob ${item.sha256}`);
      }
      const file = await materializer.materialize(bytes, item.filename);
      files.push({ ...file, evidence_id: item.id });
    }
    return {
      cleanup: materializer.cleanup,
      directory: materializer.directory,
      files,
    };
  } catch (error) {
    await materializer.cleanup();
    throw error;
  }
}
