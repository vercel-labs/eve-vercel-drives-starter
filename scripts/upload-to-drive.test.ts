import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { runNode } from "../agent/lib/testing/cli.ts";

const script = path.join(import.meta.dirname, "upload-to-drive.ts");

/**
 * Runs the upload command the way `pnpm drive:upload` does, without `.env.local`.
 *
 * @param args - Command-line arguments.
 * @returns The exit code and captured output.
 * @remarks The process can't reach the network, so a run that got as far as the Drive would fail instead of uploading.
 */
const upload = async (...args: string[]) => await runNode([script, ...args]);

describe("pnpm drive:upload", () => {
  let folder: string;

  beforeEach(async () => {
    folder = await mkdtemp(path.join(tmpdir(), "drive-upload-cli-"));
  });

  afterEach(async () => {
    await rm(folder, { force: true, recursive: true });
  });

  it("prints usage and fails when no folder is given", async () => {
    await expect(upload()).resolves.toStrictEqual({
      code: 1,
      stderr: "Usage: pnpm drive:upload <folder> [--prefix <drive/sub/dir>]\n",
      stdout: "",
    });
  });

  it("fails when the folder doesn't exist", async () => {
    const missing = path.join(folder, "missing");

    await expect(upload(missing)).resolves.toStrictEqual({
      code: 1,
      stderr: `${missing} is not a folder.\n`,
      stdout: "",
    });
  });

  it("fails when the folder has no files to upload", async () => {
    await expect(upload(folder)).resolves.toStrictEqual({
      code: 1,
      stderr: `No files found in ${folder}.\n`,
      stdout: "",
    });
  });

  it("rejects a prefix that leaves the Drive before reading the folder", async () => {
    await writeFile(path.join(folder, "a.md"), "a");

    await expect(
      upload(folder, "--prefix", "../outside")
    ).resolves.toStrictEqual({
      code: 1,
      stderr:
        'Invalid Drive path "../outside". Use a relative path like "notes/today.md".\n',
      stdout: "",
    });
  });

  it("rejects an unknown option", async () => {
    const result = await upload(folder, "--delete");

    expect(result).toMatchObject({ code: 1, stdout: "" });
    expect(result.stderr).toContain("Unknown option '--delete'");
  });
});
