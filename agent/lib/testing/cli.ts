/**
 * Runs command-line processes in tests without network access, and compiles
 * the agent with eve's CLI against a temporary copy of the app so the
 * project's `.eve` folder stays untouched.
 *
 * @packageDocumentation
 */
import { execFile } from "node:child_process";
import { cp, mkdtemp, rm, symlink } from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";

const appRoot = path.resolve(import.meta.dirname, "../../..");
const eveCli = path.join(
  path.dirname(createRequire(import.meta.url).resolve("eve/package.json")),
  "bin",
  "eve.js"
);
const offlinePreload = pathToFileURL(
  path.join(import.meta.dirname, "offline-cli.ts")
).href;

/** Upper bound on one process; it's killed after this, so a hung child can't outlive its test. */
const PROCESS_TIMEOUT_MS = 30_000;

/**
 * Exit code and captured output of a finished process.
 */
interface ProcessResult {
  code: number;
  stderr: string;
  stdout: string;
}

/**
 * Runs a Node.js script to completion in a process that can't open network connections.
 *
 * @param args - Script path and its arguments.
 * @param options - Working directory, and environment variables to add to or, with undefined, remove from this process's environment.
 * @returns The exit code and output; a nonzero exit resolves rather than rejects.
 * @remarks `NODE_ENV` and `VITEST` aren't passed on, so the script runs as it does from a terminal. Node's own warnings are silenced, so stderr holds only what the script wrote.
 */
export const runNode = async (
  args: string[],
  options: { cwd?: string; env?: Record<string, string | undefined> } = {}
): Promise<ProcessResult> => {
  const finished = Promise.withResolvers<ProcessResult>();
  const child = execFile(
    process.execPath,
    args,
    {
      cwd: options.cwd,
      env: {
        ...process.env,
        NODE_ENV: undefined,
        NODE_NO_WARNINGS: "1",
        NODE_OPTIONS: `--import=${offlinePreload}`,
        VITEST: undefined,
        ...options.env,
      },
      timeout: PROCESS_TIMEOUT_MS,
    },
    (_error, stdout, stderr) => {
      finished.resolve({ code: child.exitCode ?? 1, stderr, stdout });
    }
  );
  return await finished.promise;
};

/**
 * Copies the files eve compiles into a temporary app folder that shares the project's dependencies.
 *
 * @returns The folder, and a function that deletes it.
 */
export const copyApp = async () => {
  const root = await mkdtemp(path.join(tmpdir(), "eve-app-"));
  await Promise.all([
    cp(path.join(appRoot, "agent"), path.join(root, "agent"), {
      recursive: true,
    }),
    cp(path.join(appRoot, "package.json"), path.join(root, "package.json")),
    cp(path.join(appRoot, "tsconfig.json"), path.join(root, "tsconfig.json")),
    symlink(
      path.join(appRoot, "node_modules"),
      path.join(root, "node_modules"),
      "junction"
    ),
  ]);
  return {
    remove: async () => {
      await rm(root, { force: true, recursive: true });
    },
    root,
  };
};

/**
 * Compiles the app in a folder with `eve info --json`, as `pnpm exec eve info` does.
 *
 * @param options - The app folder, the model the catalog should list, and environment overrides for the CLI.
 * @returns The CLI's exit code and output.
 * @remarks eve looks up the model's context window in AI Gateway's model catalog when it compiles. The CLI process gets a catalog that lists only `model`, so the result doesn't depend on the live catalog.
 */
export const eveInfo = async ({
  cwd,
  env = {},
  model,
}: {
  cwd: string;
  env?: Record<string, string | undefined>;
  model: string;
}) =>
  await runNode([eveCli, "info", "--json"], {
    cwd,
    env: {
      TEST_MODEL_CATALOG: JSON.stringify({
        models: [
          {
            providers: [
              {
                contextWindowTokens: 1_000_000,
                provider: model.slice(0, model.indexOf("/")),
                providerModelId: model.slice(model.indexOf("/") + 1),
              },
            ],
            slug: model,
          },
        ],
        providerAliases: {},
      }),
      ...env,
    },
  });
