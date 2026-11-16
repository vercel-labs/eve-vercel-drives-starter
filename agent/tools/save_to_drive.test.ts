import { beforeEach, describe, expect, it } from "vitest";

import { fakeDriveService } from "../lib/testing/drive-service";
import {
  driveFixture,
  sandboxFixture,
  spyOnSandboxFactories,
} from "../lib/testing/sandbox";
import { toolContext } from "../lib/testing/tools";
import saveToDrive from "./save_to_drive";

const save = async (path: string, content = "héllo") =>
  await saveToDrive.execute({ content, path }, toolContext("save_to_drive"));

describe("save_to_drive", () => {
  let sdk: ReturnType<typeof spyOnSandboxFactories>;

  beforeEach(() => {
    sdk = spyOnSandboxFactories();
  });

  it("writes the file under the Drive mount and reports its UTF-8 size", async () => {
    const { runCommand, sandbox, stop, writeFiles } = sandboxFixture();
    sdk.getOrCreate.mockResolvedValue(driveFixture());
    sdk.create.mockResolvedValue(sandbox);

    await expect(save("notes/standup.md")).resolves.toStrictEqual({
      bytes: 6,
      path: "/drive/notes/standup.md",
      saved: true,
    });
    expect(runCommand).toHaveBeenCalledExactlyOnceWith("mkdir", [
      "-p",
      "--",
      "/drive/notes",
    ]);
    expect(writeFiles).toHaveBeenCalledExactlyOnceWith([
      { content: "héllo", path: "/drive/notes/standup.md" },
    ]);
    expect(stop).toHaveBeenCalledOnce();
  });

  it("returns invalid_path without opening the Drive", async () => {
    await expect(save("../secrets.md")).resolves.toStrictEqual({
      message:
        'Invalid Drive path "../secrets.md". Use a relative path like "notes/today.md".',
      reason: "invalid_path",
      saved: false,
    });
    expect(sdk.getOrCreate).not.toHaveBeenCalled();
  });

  it("returns drive_busy when another sandbox holds the Drive", async () => {
    sdk.getOrCreate.mockResolvedValue(driveFixture("sess_1"));

    await expect(save("notes/standup.md")).resolves.toStrictEqual({
      reason: "drive_busy",
      saved: false,
    });
    expect(sdk.create).not.toHaveBeenCalled();
  });

  it("propagates unexpected Drive failures", async () => {
    const createError = new Error("quota exceeded");
    sdk.getOrCreate.mockResolvedValue(driveFixture());
    sdk.create.mockRejectedValue(createError);

    await expect(save("notes/standup.md")).rejects.toBe(createError);
  });
});

describe("save_to_drive on an in-memory Drive", () => {
  let drive: ReturnType<typeof fakeDriveService>;
  const text = async (path: string) =>
    new TextDecoder().decode(await drive.read(path));

  beforeEach(() => {
    drive = fakeDriveService();
  });

  it("stores the content as UTF-8 at the reported path and size", async () => {
    const content = "# Standup\n\n- café ☕\n";

    const result = await save("notes/2026-11-16/standup.md", content);

    expect(result).toStrictEqual({
      bytes: 23,
      path: "/drive/notes/2026-11-16/standup.md",
      saved: true,
    });
    await expect(
      drive.read("/drive/notes/2026-11-16/standup.md")
    ).resolves.toHaveLength(23);
    await expect(text("/drive/notes/2026-11-16/standup.md")).resolves.toBe(
      content
    );
  });

  it("overwrites a file saved earlier and keeps the others", async () => {
    await save("notes/a.md", "first");
    await save("notes/b.md", "other");

    await save("notes/a.md", "second");

    await expect(drive.paths()).resolves.toStrictEqual([
      "/drive/notes/a.md",
      "/drive/notes/b.md",
    ]);
    await expect(text("/drive/notes/a.md")).resolves.toBe("second");
    await expect(text("/drive/notes/b.md")).resolves.toBe("other");
  });

  it("saves an empty file", async () => {
    await expect(save("notes/empty.md", "")).resolves.toMatchObject({
      bytes: 0,
      saved: true,
    });
    await expect(drive.read("/drive/notes/empty.md")).resolves.toHaveLength(0);
  });

  it.each([
    "/etc/passwd",
    "../outside.md",
    "notes/../../outside.md",
    "notes//a.md",
    "notes/",
    " notes/a.md",
    "a\0b",
  ])("writes nothing for the invalid path %j", async (path) => {
    await expect(save(path)).resolves.toMatchObject({
      reason: "invalid_path",
      saved: false,
    });
    expect(drive.getOrCreate).not.toHaveBeenCalled();
    await expect(drive.paths()).resolves.toStrictEqual([]);
  });

  it("saves one of two simultaneous calls and reports the other as busy", async () => {
    const results = await Promise.all([
      save("notes/a.md", "a"),
      save("notes/b.md", "b"),
    ]);

    expect(results).toStrictEqual([
      { bytes: 1, path: "/drive/notes/a.md", saved: true },
      { reason: "drive_busy", saved: false },
    ]);
    await expect(drive.paths()).resolves.toStrictEqual(["/drive/notes/a.md"]);
  });

  it("saves on a retry once the Drive is free again", async () => {
    drive.hold("sess_upload");
    await expect(save("notes/a.md")).resolves.toStrictEqual({
      reason: "drive_busy",
      saved: false,
    });

    drive.release();

    await expect(save("notes/a.md")).resolves.toMatchObject({ saved: true });
    await expect(drive.paths()).resolves.toStrictEqual(["/drive/notes/a.md"]);
  });
});
