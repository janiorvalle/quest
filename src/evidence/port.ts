export interface EvidenceFile {
  readonly bytes: Uint8Array;
  readonly filename: string;
}

export interface EvidenceFileReader {
  read(filePath: string, workingDirectory: string): Promise<EvidenceFile>;
}
