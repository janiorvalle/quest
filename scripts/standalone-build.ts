import { fileURLToPath } from "node:url";

const parserWorkerNamespace = "opentui-parser-worker";
const parserWorkerSpecifier = /^@opentui\/core\/parser\.worker$/;
const parserWorkerPath = fileURLToPath(import.meta.resolve("@opentui/core/parser.worker"));

export interface StandaloneBuildOptions {
  readonly define?: Readonly<Record<string, string>>;
  readonly entrypoint: string;
  readonly requiredAssets?: readonly string[];
  readonly outfile: string;
  readonly target: Bun.Build.CompileTarget;
}

export function createOpenTuiParserWorkerPlugin(): Bun.BunPlugin {
  return {
    name: "opentui-parser-worker-file",
    setup(build) {
      // Bun 1.3.6 otherwise compiles this package export as JavaScript, not a file asset.
      build.onResolve({ filter: parserWorkerSpecifier }, () => ({
        namespace: parserWorkerNamespace,
        path: parserWorkerPath,
      }));
      build.onLoad({ filter: /.*/, namespace: parserWorkerNamespace }, async () => ({
        contents: new Uint8Array(await Bun.file(parserWorkerPath).arrayBuffer()),
        loader: "file",
      }));
    },
  };
}

export async function buildStandaloneExecutable(options: StandaloneBuildOptions): Promise<void> {
  const define: Record<string, string> = { ...options.define };

  for (const assetPath of options.requiredAssets ?? []) {
    if (!(await Bun.file(assetPath).exists())) {
      throw new Error(
        `DIST_ASSET_MISSING: required bundled asset ${assetPath} is missing; restore it and retry the distribution build`,
      );
    }
  }

  if (options.target.startsWith("bun-linux-")) {
    define["process.env.OPENTUI_LIBC"] = JSON.stringify(
      options.target.endsWith("-musl") ? "musl" : "glibc",
    );
  }

  const result = await Bun.build({
    compile: {
      autoloadBunfig: false,
      autoloadDotenv: false,
      outfile: options.outfile,
      target: options.target,
    },
    define,
    entrypoints: [options.entrypoint],
    minify: true,
    plugins: [createOpenTuiParserWorkerPlugin()],
  });

  if (!result.success) {
    throw new Error(result.logs.map((log) => log.message).join("\n"));
  }
}
