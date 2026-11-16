/**
 * A stateful, in-memory stand-in for the Vercel Drive and Sandbox APIs. Unlike
 * the spies in `./sandbox`, it keeps the Drive's files and its single
 * read-write mount between calls, so tests assert what ends up on the Drive
 * instead of which SDK methods were called.
 *
 * @packageDocumentation
 */
import { Drive, Sandbox } from "@vercel/sandbox";
import { Bash } from "just-bash";
import { vi } from "vitest";
import { z } from "zod";

import { DRIVE_PATH } from "../drive";
import {
  commandFinished,
  driveFixture,
  sandboxFixture,
  stoppedSession,
} from "./sandbox";

/** The `runCommand(command, args)` call shape the Drive code uses. */
const argvSchema = z.tuple([z.string(), z.array(z.string())]);

/**
 * Replaces the SDK's Drive and Sandbox factories with an in-memory Drive for one test.
 *
 * @returns Accessors for the Drive's files and its read-write mount, plus the factory spies.
 * @remarks Commands run in a shell interpreter over an in-memory filesystem, so `mkdir` and `rm` change real paths instead of being recorded. Like the Sandbox API, creating a sandbox fails while another holds the Drive's read-write mount, and stopping a sandbox releases it. Writing a file whose parent directory is missing fails. It ignores the options passed to `Drive.getOrCreate` and `Sandbox.create`, and doesn't model snapshots, size limits, or timeouts, so assert the exact SDK calls with the spies in `./sandbox`. Call from a test or `beforeEach`; `restoreMocks` restores the real factories afterward.
 */
export const fakeDriveService = () => {
  const shell = new Bash();
  let holder: string | undefined;
  let created = 0;

  const getOrCreate = vi
    .spyOn(Drive, "getOrCreate")
    .mockImplementation(
      async () => await Promise.resolve(driveFixture(holder))
    );

  const create = vi.spyOn(Sandbox, "create").mockImplementation(async () => {
    if (holder !== undefined) {
      throw new Error(`Drive is attached to sandbox session ${holder}.`);
    }
    created += 1;
    const sessionId = `sess_${created}`;
    holder = sessionId;
    const { runCommand, sandbox, stop, writeFiles } = sandboxFixture();
    runCommand.mockImplementation(async (...input: unknown[]) => {
      const [command, args] = argvSchema.parse(input);
      const result = await shell.exec(command, { args });
      return commandFinished(result.exitCode, result.stderr, result.stdout);
    });
    writeFiles.mockImplementation(async (files) => {
      await Promise.all(
        files.map(async ({ content, path }) => {
          const parent = path.slice(0, path.lastIndexOf("/"));
          if (!(await shell.fs.exists(parent))) {
            throw new Error(
              `ENOENT: no such file or directory, open '${path}'`
            );
          }
          await shell.fs.writeFile(path, content);
        })
      );
    });
    stop.mockImplementation(async () => {
      if (holder === sessionId) {
        holder = undefined;
      }
      return await Promise.resolve(stoppedSession());
    });
    return await Promise.resolve(sandbox);
  });

  return {
    create,
    getOrCreate,
    /**
     * Marks the read-write mount as held by a sandbox outside the test, such as an upload in progress.
     *
     * @param sessionId - Session to report as the holder.
     */
    hold(sessionId: string) {
      holder = sessionId;
    },
    /**
     * Reports the sandbox session holding the read-write mount.
     *
     * @returns The session ID, or undefined when the Drive is free.
     */
    holder: () => holder,
    /**
     * Lists the files on the Drive.
     *
     * @returns Absolute file paths under DRIVE_PATH, sorted, without directories.
     */
    async paths() {
      const candidates = shell.fs
        .getAllPaths()
        .filter((path) => path.startsWith(`${DRIVE_PATH}/`));
      const stats = await Promise.all(
        candidates.map(async (path) => await shell.fs.stat(path))
      );
      return candidates.filter((_, index) => stats[index].isFile).toSorted();
    },
    /**
     * Reads a file's bytes from the Drive.
     *
     * @param path - Absolute path under DRIVE_PATH.
     * @returns A copy of the stored bytes.
     */
    read: async (path: string) =>
      Uint8Array.from(await shell.fs.readFileBuffer(path)),
    /** Releases a mount taken with `hold`. */
    release() {
      holder = undefined;
    },
  };
};
