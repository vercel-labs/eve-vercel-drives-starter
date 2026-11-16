import nodePath from "node:path";

import { beforeEach, describe, expect, it, vi } from "vitest";

import {
  DRIVE_NAME,
  DRIVE_REGION,
  DriveBusyError,
  resolveDrivePath,
  sandboxDriveWorkspace,
  withWritableDrive,
} from "./drive";
import { fakeDriveService } from "./testing/drive-service";
import {
  commandFinished,
  driveFixture,
  sandboxFixture,
  spyOnSandboxFactories,
} from "./testing/sandbox";

/**
 * Builds a deterministic pseudo-random generator, so generated cases are the same on every run.
 *
 * @param seed - Starting state.
 * @returns A function returning the next integer below its bound.
 */
const seededRandom = (seed: number) => {
  let state = seed;
  return (bound: number) => {
    state = (Math.imul(state, 1_103_515_245) + 12_345) % 2_147_483_648;
    return Math.abs(state) % bound;
  };
};

/**
 * Writes one text file in its own write session.
 *
 * @param name - Drive-relative path.
 * @param content - Text to write; defaults to the path.
 * @returns The Drive-relative path.
 */
const writeFile = async (name: string, content = name) =>
  await withWritableDrive(async (workspace) => {
    await workspace.writeFiles([{ content, path: resolveDrivePath(name) }]);
    return name;
  });

/** Segments a hostile or careless caller might put in a path, valid and invalid. */
const SEGMENT_POOL = [
  "notes",
  "a b",
  "-rf",
  "$(id)",
  "über",
  "x".repeat(255),
  "..",
  ".",
  "",
  " pad",
  "pad ",
  "a\0b",
  "x".repeat(256),
  // 128 characters but 256 UTF-8 bytes.
  "é".repeat(128),
];

describe("Drive configuration", () => {
  it.each([
    [{ DRIVE_NAME: "team-drive", DRIVE_REGION: "" }, "team-drive", "iad1"],
    [{ DRIVE_NAME: undefined, DRIVE_REGION: "sfo1" }, "eve-drive", "sfo1"],
  ])(
    "reads %o from the environment, treating empty values as unset",
    async (env, name, region) => {
      for (const [key, value] of Object.entries(env)) {
        vi.stubEnv(key, value);
      }
      vi.resetModules();

      const drive = await import("./drive");

      expect([drive.DRIVE_NAME, drive.DRIVE_REGION]).toStrictEqual([
        name,
        region,
      ]);
    }
  );
});

describe(resolveDrivePath, () => {
  it.each([
    ["notes/today.md", "/drive/notes/today.md"],
    ["a b/c d.md", "/drive/a b/c d.md"],
    [`${"é".repeat(127)}a`, `/drive/${"é".repeat(127)}a`],
  ])("resolves %j under the mount", (relative, absolute) => {
    expect(resolveDrivePath(relative)).toBe(absolute);
  });

  it.each([
    "",
    "/etc/passwd",
    "../secrets",
    "notes/../../secrets",
    "notes//a.md",
    "notes/./a.md",
    "notes/",
    "a\0b",
    " notes/a.md",
    "notes/a.md ",
    "x".repeat(256),
    // 128 characters but 256 UTF-8 bytes.
    "é".repeat(128),
  ])("rejects %j", (path) => {
    expect(() => resolveDrivePath(path)).toThrow(
      `Invalid Drive path "${path}".`
    );
  });
});

describe("resolveDrivePath over generated paths", () => {
  const next = seededRandom(20_261_116);
  const paths = Array.from({ length: 300 }, () =>
    Array.from(
      { length: 1 + next(4) },
      () => SEGMENT_POOL[next(SEGMENT_POOL.length)]
    ).join("/")
  );

  it("either rejects a path or resolves it to a normalized path inside the mount", () => {
    const outcomes = paths.map((candidate) => {
      let resolved: string;
      try {
        resolved = resolveDrivePath(candidate);
      } catch {
        return "rejected";
      }
      expect(resolved).toBe(`/drive/${candidate}`);
      expect(nodePath.posix.normalize(resolved)).toBe(resolved);
      expect(nodePath.posix.relative("/drive", resolved)).toBe(candidate);
      return "resolved";
    });

    expect(new Set(outcomes)).toStrictEqual(new Set(["rejected", "resolved"]));
  });

  it("rejects exactly the paths that contain an unsafe segment", () => {
    const unsafe = new Set(["..", ".", "", " pad", "pad ", "a\0b"]);
    for (const candidate of paths) {
      const expected = candidate
        .split("/")
        .some(
          (segment) =>
            unsafe.has(segment) ||
            new TextEncoder().encode(segment).length > 255
        );
      const rejected = (() => {
        try {
          resolveDrivePath(candidate);
          return false;
        } catch {
          return true;
        }
      })();

      expect({ candidate, rejected }).toStrictEqual({
        candidate,
        rejected: expected,
      });
    }
  });
});

describe(sandboxDriveWorkspace, () => {
  it("creates each parent directory once before writing files", async () => {
    const { runCommand, sandbox, writeFiles } = sandboxFixture();
    const files = [
      { content: "a", path: "/drive/notes/a.md" },
      { content: "b", path: "/drive/notes/b.md" },
      { content: new Uint8Array([1]), path: "/drive/c.bin" },
    ];

    await sandboxDriveWorkspace(sandbox).writeFiles(files);

    expect(runCommand).toHaveBeenCalledExactlyOnceWith("mkdir", [
      "-p",
      "--",
      "/drive/notes",
      "/drive",
    ]);
    expect(writeFiles).toHaveBeenCalledExactlyOnceWith(files);
    expect(runCommand.mock.invocationCallOrder[0]).toBeLessThan(
      writeFiles.mock.invocationCallOrder[0]
    );
  });

  it("removes files without treating paths as options", async () => {
    const { runCommand, sandbox } = sandboxFixture();

    await sandboxDriveWorkspace(sandbox).remove(["/drive/a.md", "/drive/b.md"]);

    expect(runCommand).toHaveBeenCalledExactlyOnceWith("rm", [
      "-f",
      "--",
      "/drive/a.md",
      "/drive/b.md",
    ]);
  });

  it("runs no commands for empty writes and removals", async () => {
    const { runCommand, sandbox, writeFiles } = sandboxFixture();
    const workspace = sandboxDriveWorkspace(sandbox);

    await workspace.writeFiles([]);
    await workspace.remove([]);

    expect(runCommand).not.toHaveBeenCalled();
    expect(writeFiles).not.toHaveBeenCalled();
  });

  it("throws with trimmed stderr and skips the write when mkdir fails", async () => {
    const { runCommand, sandbox, writeFiles } = sandboxFixture();
    runCommand.mockResolvedValue(commandFinished(1, "denied\n"));

    await expect(
      sandboxDriveWorkspace(sandbox).writeFiles([
        { content: "a", path: "/drive/a.md" },
      ])
    ).rejects.toThrow(
      new Error("mkdir failed in the Drive sandbox (exit 1): denied")
    );
    expect(writeFiles).not.toHaveBeenCalled();
  });
});

describe(DriveBusyError, () => {
  it("names the Drive and the session holding it", () => {
    const error = new DriveBusyError("sess_1");

    expect(error).toMatchObject({
      message: `Drive "${DRIVE_NAME}" is in use by Vercel Sandbox session sess_1.`,
      name: "DriveBusyError",
      sessionId: "sess_1",
    });
  });
});

describe(withWritableDrive, () => {
  let sdk: ReturnType<typeof spyOnSandboxFactories>;

  beforeEach(() => {
    sdk = spyOnSandboxFactories();
  });

  it("mounts the Drive read-write without network access, passes the workspace to the callback, and stops the sandbox", async () => {
    const drive = driveFixture();
    const { sandbox, stop, writeFiles } = sandboxFixture();
    sdk.getOrCreate.mockResolvedValue(drive);
    sdk.create.mockResolvedValue(sandbox);
    const file = { content: "a", path: "/drive/a.md" };

    await expect(
      withWritableDrive(async (workspace) => {
        await workspace.writeFiles([file]);
        return "ok";
      })
    ).resolves.toBe("ok");
    expect(sdk.getOrCreate).toHaveBeenCalledExactlyOnceWith({
      name: DRIVE_NAME,
      region: DRIVE_REGION,
    });
    expect(sdk.create).toHaveBeenCalledExactlyOnceWith({
      mounts: { "/drive": drive },
      networkPolicy: "deny-all",
      persistent: false,
      region: DRIVE_REGION,
      tags: { application: "eve-vercel-drives-starter" },
      timeout: 300_000,
    });
    expect(writeFiles).toHaveBeenCalledExactlyOnceWith([file]);
    expect(stop).toHaveBeenCalledExactlyOnceWith();
  });

  it("treats an empty session ID as a free Drive", async () => {
    const { sandbox } = sandboxFixture();
    sdk.getOrCreate.mockResolvedValue(driveFixture(""));
    sdk.create.mockResolvedValue(sandbox);

    await expect(
      withWritableDrive(vi.fn<() => Promise<string>>().mockResolvedValue("ok"))
    ).resolves.toBe("ok");
  });

  it("throws DriveBusyError without creating a sandbox when another sandbox holds the mount", async () => {
    sdk.getOrCreate.mockResolvedValue(driveFixture("sess_1"));
    const write = vi.fn<() => Promise<void>>();

    await expect(withWritableDrive(write)).rejects.toStrictEqual(
      new DriveBusyError("sess_1")
    );
    expect(sdk.create).not.toHaveBeenCalled();
    expect(write).not.toHaveBeenCalled();
  });

  it("throws DriveBusyError for the session that took the mount while the sandbox was being created", async () => {
    sdk.getOrCreate
      .mockResolvedValueOnce(driveFixture())
      .mockResolvedValueOnce(driveFixture("sess_2"));
    sdk.create.mockRejectedValue(new Error("drive already attached"));

    const result = withWritableDrive(vi.fn<() => Promise<void>>());

    await expect(result).rejects.toBeInstanceOf(DriveBusyError);
    await expect(result).rejects.toMatchObject({ sessionId: "sess_2" });
  });

  it.each([
    [
      "the Drive is still free",
      (getOrCreate: typeof sdk.getOrCreate) =>
        getOrCreate.mockResolvedValueOnce(driveFixture()),
    ],
    [
      "the Drive cannot be re-read",
      (getOrCreate: typeof sdk.getOrCreate) =>
        getOrCreate.mockRejectedValueOnce(new Error("lookup failed")),
    ],
  ])("rethrows the create error when %s", async (_case, recheck) => {
    const createError = new Error("quota exceeded");
    recheck(sdk.getOrCreate.mockResolvedValueOnce(driveFixture()));
    sdk.create.mockRejectedValue(createError);

    await expect(withWritableDrive(vi.fn<() => Promise<void>>())).rejects.toBe(
      createError
    );
  });

  it("stops the sandbox and rethrows when the callback fails", async () => {
    const { sandbox, stop } = sandboxFixture();
    sdk.getOrCreate.mockResolvedValue(driveFixture());
    sdk.create.mockResolvedValue(sandbox);
    const writeError = new Error("write failed");

    await expect(
      withWritableDrive(
        vi.fn<() => Promise<void>>().mockRejectedValue(writeError)
      )
    ).rejects.toBe(writeError);
    expect(stop).toHaveBeenCalledOnce();
  });

  it("returns the callback result and logs when stopping the sandbox fails", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const { sandbox, stop } = sandboxFixture();
    stop.mockRejectedValue(new Error("stop failed"));
    sdk.getOrCreate.mockResolvedValue(driveFixture());
    sdk.create.mockResolvedValue(sandbox);

    await expect(
      withWritableDrive(vi.fn<() => Promise<string>>().mockResolvedValue("ok"))
    ).resolves.toBe("ok");
    expect(warn).toHaveBeenCalledExactlyOnceWith("drive.stop_failed", {
      message: "stop failed",
    });
  });
});

describe("writes to an in-memory Drive", () => {
  let drive: ReturnType<typeof fakeDriveService>;

  beforeEach(() => {
    drive = fakeDriveService();
  });

  it("keeps text and bytes from separate write sessions", async () => {
    const bytes = Uint8Array.from([0x00, 0xff, 0x0a, 0x80]);

    await withWritableDrive(async (workspace) => {
      await workspace.writeFiles([
        { content: "héllo\n", path: resolveDrivePath("notes/2026/standup.md") },
      ]);
    });
    await withWritableDrive(async (workspace) => {
      await workspace.writeFiles([
        { content: bytes, path: resolveDrivePath("images/logo.bin") },
      ]);
    });

    await expect(drive.paths()).resolves.toStrictEqual([
      "/drive/images/logo.bin",
      "/drive/notes/2026/standup.md",
    ]);
    await expect(drive.read("/drive/images/logo.bin")).resolves.toStrictEqual(
      bytes
    );
    await expect(
      drive.read("/drive/notes/2026/standup.md")
    ).resolves.toStrictEqual(new TextEncoder().encode("héllo\n"));
    expect(drive.create).toHaveBeenCalledTimes(2);
    expect(drive.holder()).toBeUndefined();
  });

  it("replaces the content of an existing file", async () => {
    await writeFile("notes/a.md", "first version, the longer one");
    await writeFile("notes/a.md", "second");

    await expect(drive.read("/drive/notes/a.md")).resolves.toStrictEqual(
      new TextEncoder().encode("second")
    );
  });

  it("stores shell-special names as literal path segments", async () => {
    const names = [
      "-rf/--force.md",
      "$(touch pwned)/`id`.md",
      "a;b && c/*.md",
      'it\'s "quoted"/new\nline.md',
    ];

    await withWritableDrive(async (workspace) => {
      await workspace.writeFiles(
        names.map((name) => ({
          content: name,
          path: resolveDrivePath(name),
        }))
      );
    });

    await expect(drive.paths()).resolves.toStrictEqual(
      names.map((name) => `/drive/${name}`).toSorted()
    );
  });

  it("removes only the named files and ignores missing ones", async () => {
    await withWritableDrive(async (workspace) => {
      await workspace.writeFiles(
        ["notes/keep.md", "notes/drop.md", "-drop.md"].map((name) => ({
          content: name,
          path: resolveDrivePath(name),
        }))
      );
    });

    await withWritableDrive(async (workspace) => {
      await workspace.remove(
        ["notes/drop.md", "-drop.md", "notes/never-existed.md"].map(
          resolveDrivePath
        )
      );
    });

    await expect(drive.paths()).resolves.toStrictEqual([
      "/drive/notes/keep.md",
    ]);
  });

  it("reports the shell's error when asked to remove a folder", async () => {
    await withWritableDrive(async (workspace) => {
      await workspace.writeFiles([
        { content: "a", path: resolveDrivePath("notes/a.md") },
      ]);
    });

    await expect(
      withWritableDrive(async (workspace) => {
        await workspace.remove([resolveDrivePath("notes")]);
      })
    ).rejects.toThrow(
      "rm failed in the Drive sandbox (exit 1): rm: cannot remove '/drive/notes': Is a directory"
    );
    await expect(drive.paths()).resolves.toStrictEqual(["/drive/notes/a.md"]);
    expect(drive.holder()).toBeUndefined();
  });

  it("lets one of two concurrent writers through and reports the other as busy", async () => {
    const results = await Promise.allSettled([
      writeFile("a.md"),
      writeFile("b.md"),
    ]);

    expect(results).toStrictEqual([
      { status: "fulfilled", value: "a.md" },
      { reason: new DriveBusyError("sess_1"), status: "rejected" },
    ]);
    await expect(drive.paths()).resolves.toStrictEqual(["/drive/a.md"]);
    expect(drive.holder()).toBeUndefined();
  });

  it("stays busy while another sandbox holds the mount and writes again once it's released", async () => {
    drive.hold("sess_upload");

    await expect(writeFile("a.md")).rejects.toStrictEqual(
      new DriveBusyError("sess_upload")
    );
    await expect(drive.paths()).resolves.toStrictEqual([]);

    drive.release();

    await expect(writeFile("a.md")).resolves.toBe("a.md");
    await expect(drive.paths()).resolves.toStrictEqual(["/drive/a.md"]);
  });

  it("releases the mount after a failed write so the next write succeeds", async () => {
    await expect(
      withWritableDrive(
        vi
          .fn<() => Promise<void>>()
          .mockRejectedValue(new Error("write failed"))
      )
    ).rejects.toThrow("write failed");

    await expect(writeFile("a.md")).resolves.toBe("a.md");
    expect(drive.holder()).toBeUndefined();
  });
});
