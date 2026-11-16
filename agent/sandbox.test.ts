import type { SandboxSelectorContext } from "eve/sandbox";
import { VercelSandbox } from "eve/sandbox/vercel";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { MockInstance } from "vitest";

import sandbox, { environment } from "./sandbox";

type Session = Awaited<ReturnType<typeof environment.open>>;

const unsupported = (name: string) => (): never => {
  throw new Error(`This test does not provide ${name}.`);
};

/**
 * Builds the session eve's Vercel environment returns from `open`.
 *
 * @param name - Sandbox name, used to tell sessions apart.
 * @returns A session whose file, command, and lifecycle methods fail when unexpectedly called.
 */
const session = (name: string): Session => ({
  delete: unsupported("sandbox deletion"),
  name,
  readBinaryFile: unsupported("file reads"),
  readFile: unsupported("file reads"),
  readTextFile: unsupported("file reads"),
  removePath: unsupported("file removal"),
  resolvePath: unsupported("path resolution"),
  run: unsupported("commands"),
  setNetworkPolicy: unsupported("network policy changes"),
  spawn: unsupported("processes"),
  stop: unsupported("sandbox stops"),
  writeBinaryFile: unsupported("file writes"),
  writeFile: unsupported("file writes"),
  writeFiles: unsupported("file writes"),
  writeTextFile: unsupported("file writes"),
});

const context: SandboxSelectorContext = {
  session: {
    auth: { current: null, initiator: null },
    id: "session_1",
    turn: { id: "turn_1", sequence: 1 },
  },
};

describe("session sandbox", () => {
  let open: MockInstance<typeof environment.open>;

  beforeEach(() => {
    open = vi.spyOn(environment, "open");
  });

  it("always runs on Vercel Sandbox", () => {
    expect(environment.provider).toBe("vercel");
  });

  it("mounts a read-only snapshot of the Drive at /drive and denies network access", async () => {
    const mounted = session("mounted");
    open.mockResolvedValue(mounted);

    await expect(sandbox(context)).resolves.toBe(mounted);
    expect(open).toHaveBeenCalledOnce();
    const [[options]] = open.mock.calls;
    expect(options).toHaveProperty(["mounts", "/drive"], {
      drive: "eve-drive",
      mode: "snapshot",
    });
    expect(options).toHaveProperty("networkPolicy", "deny-all");
  });

  it("falls back to a sandbox without the Drive, still without network access, when the mount fails", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const unmounted = session("unmounted");
    open
      .mockRejectedValueOnce(new Error("drive_not_initialized"))
      .mockResolvedValueOnce(unmounted);

    await expect(sandbox(context)).resolves.toBe(unmounted);
    expect(open).toHaveBeenCalledTimes(2);
    expect(open).toHaveBeenLastCalledWith({ networkPolicy: "deny-all" });
    expect(warn).toHaveBeenCalledExactlyOnceWith("drive.unavailable", {
      message: "drive_not_initialized",
    });
  });

  it("never mounts the Drive read-write", async () => {
    open.mockRejectedValue(new Error("unavailable"));
    vi.spyOn(console, "warn").mockImplementation(() => {});

    await expect(sandbox(context)).rejects.toThrow("unavailable");
    expect(JSON.stringify(open.mock.calls)).not.toContain("read-write");
  });

  it("surfaces the error when the fallback sandbox can't open either", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const failure = new Error("OIDC credentials expired");
    open
      .mockRejectedValueOnce(new Error("drive_not_initialized"))
      .mockRejectedValueOnce(failure);

    await expect(sandbox(context)).rejects.toBe(failure);
  });
});

describe("sandbox environment", () => {
  it.each([
    [undefined, undefined, "eve-drive", "iad1"],
    ["team-drive", "sfo1", "team-drive", "sfo1"],
  ])(
    "runs in the Drive's region and mounts the configured Drive (DRIVE_NAME=%s, DRIVE_REGION=%s)",
    async (driveName, driveRegion, name, region) => {
      vi.stubEnv("DRIVE_NAME", driveName);
      vi.stubEnv("DRIVE_REGION", driveRegion);
      vi.resetModules();
      const create = vi.spyOn(VercelSandbox, "environment");

      const configured = await import("./sandbox");
      const open = vi
        .spyOn(configured.environment, "open")
        .mockResolvedValue(session("configured"));
      await configured.default(context);

      expect(create).toHaveBeenCalledExactlyOnceWith({ region });
      expect(open.mock.calls[0][0]).toHaveProperty(["mounts", "/drive"], {
        drive: name,
        mode: "snapshot",
      });
    }
  );
});
