import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { DriveBusyError } from "../../agent/lib/drive.ts";
import { fakeDriveService } from "../../agent/lib/testing/drive-service.ts";
import {
  driveFixture,
  sandboxFixture,
  spyOnSandboxFactories,
} from "../../agent/lib/testing/sandbox.ts";
import {
  describeUploadError,
  listUploadFiles,
  uploadFolder,
  WRITE_BATCH,
} from "./upload.ts";

let folder: string;

/**
 * Writes a file under the test folder, creating its parent directories.
 *
 * @param relativePath - Slash-separated path inside the test folder.
 * @param content - File content.
 */
const put = async (
  relativePath: string,
  content: string | Uint8Array = "x"
) => {
  const file = path.join(folder, ...relativePath.split("/"));
  await mkdir(path.dirname(file), { recursive: true });
  await writeFile(file, content);
};

describe("drive upload", () => {
  beforeEach(async () => {
    folder = await mkdtemp(path.join(tmpdir(), "drive-upload-"));
  });

  afterEach(async () => {
    await rm(folder, { force: true, recursive: true });
  });

  describe(listUploadFiles, () => {
    it("maps nested files to Drive paths and skips dot segments and symlinks", async () => {
      await put("a.md");
      await put("sub/b.md");
      await put(".env");
      await put(".git/config");
      await put("sub/.hidden/c.md");
      await symlink(path.join(folder, "a.md"), path.join(folder, "link.md"));

      const { files, skipped } = await listUploadFiles(folder);

      expect(files.map(({ drivePath }) => drivePath)).toStrictEqual([
        "/drive/a.md",
        "/drive/sub/b.md",
      ]);
      expect(skipped).toBe(1);
    });

    it("places files under the prefix", async () => {
      await put("runbooks/deploy.md");

      const { files } = await listUploadFiles(folder, "docs");

      expect(files).toStrictEqual([
        {
          drivePath: "/drive/docs/runbooks/deploy.md",
          localPath: path.join(folder, "runbooks", "deploy.md"),
        },
      ]);
    });
  });

  describe(uploadFolder, () => {
    let sdk: ReturnType<typeof spyOnSandboxFactories>;

    beforeEach(() => {
      sdk = spyOnSandboxFactories();
    });

    it("writes file bytes unchanged and stops the sandbox", async () => {
      const bytes = Uint8Array.from([0xff, 0xfe, 0x00, 0x01]);
      await put("image.bin", bytes);
      await put("notes/a.md", "héllo");
      const { sandbox, stop, writeFiles } = sandboxFixture();
      sdk.getOrCreate.mockResolvedValue(driveFixture());
      sdk.create.mockResolvedValue(sandbox);

      await expect(uploadFolder({ folder })).resolves.toStrictEqual({
        paths: ["/drive/image.bin", "/drive/notes/a.md"],
        skipped: 0,
      });
      expect(writeFiles).toHaveBeenCalledExactlyOnceWith([
        { content: Buffer.from(bytes), path: "/drive/image.bin" },
        { content: Buffer.from("héllo"), path: "/drive/notes/a.md" },
      ]);
      expect(stop).toHaveBeenCalledOnce();
    });

    it("writes in sequential batches of WRITE_BATCH files", async () => {
      await Promise.all(
        Array.from({ length: WRITE_BATCH + 1 }, async (_, index) => {
          await put(`f${String(index).padStart(3, "0")}.md`);
        })
      );
      const { sandbox, writeFiles } = sandboxFixture();
      sdk.getOrCreate.mockResolvedValue(driveFixture());
      sdk.create.mockResolvedValue(sandbox);

      await uploadFolder({ folder });

      expect(
        writeFiles.mock.calls.map(([files]) => files.length)
      ).toStrictEqual([WRITE_BATCH, 1]);
    });

    it("strips trailing slashes from the prefix", async () => {
      await put("a.md");
      const { sandbox } = sandboxFixture();
      sdk.getOrCreate.mockResolvedValue(driveFixture());
      sdk.create.mockResolvedValue(sandbox);

      await expect(
        uploadFolder({ folder, prefix: "docs//" })
      ).resolves.toStrictEqual({ paths: ["/drive/docs/a.md"], skipped: 0 });
    });

    it("rejects an invalid prefix before opening the Drive", async () => {
      await put("a.md");

      await expect(uploadFolder({ folder, prefix: "/abs" })).rejects.toThrow(
        'Invalid Drive path "/abs".'
      );
      expect(sdk.getOrCreate).not.toHaveBeenCalled();
    });

    it("rejects a path that isn't a folder", async () => {
      await put("a.md");
      const file = path.join(folder, "a.md");

      await expect(uploadFolder({ folder: file })).rejects.toThrow(
        `${file} is not a folder.`
      );
      await expect(
        uploadFolder({ folder: path.join(folder, "missing") })
      ).rejects.toThrow("is not a folder.");
    });

    it("rejects a folder with nothing to upload before opening the Drive", async () => {
      await put(".env");

      await expect(uploadFolder({ folder })).rejects.toThrow(
        `No files found in ${folder}.`
      );
      expect(sdk.getOrCreate).not.toHaveBeenCalled();
    });

    it("surfaces DriveBusyError when another sandbox holds the read-write mount", async () => {
      await put("a.md");
      sdk.getOrCreate.mockResolvedValue(driveFixture("sess_1"));

      await expect(uploadFolder({ folder })).rejects.toBeInstanceOf(
        DriveBusyError
      );
      expect(sdk.create).not.toHaveBeenCalled();
    });
  });

  describe("uploads to an in-memory Drive", () => {
    let drive: ReturnType<typeof fakeDriveService>;

    beforeEach(() => {
      drive = fakeDriveService();
    });

    it("copies a folder tree byte for byte in one write session", async () => {
      const bytes = Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0x00, 0xff]);
      await put("welcome.md", "héllo");
      await put("handbook/onboarding.md", "# Onboarding");
      await put("handbook/assets/logo.png", bytes);
      await put(".env", "SECRET=1");

      await expect(uploadFolder({ folder })).resolves.toStrictEqual({
        paths: [
          "/drive/handbook/assets/logo.png",
          "/drive/handbook/onboarding.md",
          "/drive/welcome.md",
        ],
        skipped: 0,
      });

      await expect(drive.paths()).resolves.toStrictEqual([
        "/drive/handbook/assets/logo.png",
        "/drive/handbook/onboarding.md",
        "/drive/welcome.md",
      ]);
      await expect(
        drive.read("/drive/handbook/assets/logo.png")
      ).resolves.toStrictEqual(bytes);
      await expect(drive.read("/drive/welcome.md")).resolves.toStrictEqual(
        new TextEncoder().encode("héllo")
      );
    });

    it("uses one write session and frees the Drive afterward", async () => {
      await put("a.md");
      await put("sub/b.md");

      await uploadFolder({ folder });

      expect(drive.create).toHaveBeenCalledOnce();
      expect(drive.holder()).toBeUndefined();
    });

    it("uploads more than one batch of files", async () => {
      const names = Array.from(
        { length: WRITE_BATCH * 2 + 3 },
        (_, index) => `f${String(index).padStart(3, "0")}.md`
      );
      await Promise.all(
        names.map(async (name) => {
          await put(name, name);
        })
      );

      await uploadFolder({ folder, prefix: "bulk" });

      await expect(drive.paths()).resolves.toStrictEqual(
        names.map((name) => `/drive/bulk/${name}`)
      );
      expect(drive.create).toHaveBeenCalledOnce();
    });

    it("overwrites files at the same paths and leaves the rest of the Drive alone", async () => {
      await put("a.md", "old");
      await put("keep.md", "keep");
      await uploadFolder({ folder, prefix: "docs" });
      await rm(path.join(folder, "keep.md"));
      await put("a.md", "new");

      await uploadFolder({ folder, prefix: "docs/" });

      await expect(drive.paths()).resolves.toStrictEqual([
        "/drive/docs/a.md",
        "/drive/docs/keep.md",
      ]);
      await expect(drive.read("/drive/docs/a.md")).resolves.toStrictEqual(
        new TextEncoder().encode("new")
      );
    });

    it("uploads nothing while another sandbox holds the Drive", async () => {
      await put("a.md");
      drive.hold("sess_save");

      await expect(uploadFolder({ folder })).rejects.toStrictEqual(
        new DriveBusyError("sess_save")
      );
      await expect(drive.paths()).resolves.toStrictEqual([]);
    });
  });

  describe(describeUploadError, () => {
    it("adds a retry hint only for a busy Drive", () => {
      const busy = new DriveBusyError("sess_1");

      expect(describeUploadError(busy)).toBe(
        `${busy.message} Try again when it finishes.`
      );
      expect(describeUploadError(new Error("No files found in x."))).toBe(
        "No files found in x."
      );
    });
  });
});
