/**
 * Type-level contracts for the template's public surface and its fit with
 * eve's types. The assertions are checked by `pnpm typecheck`; running the
 * file with Vitest only confirms it loads.
 *
 * @packageDocumentation
 */
import type { AgentDefinition, SessionUsageLimit } from "eve";
import type { SandboxSelector } from "eve/sandbox";
import type { ToolContext } from "eve/tools";
import { describe, expectTypeOf, it } from "vitest";

import type agent from "./agent";
import type {
  DriveBusyError,
  DriveWorkspace,
  resolveDrivePath,
  withWritableDrive,
} from "./lib/drive";
import type sandbox from "./sandbox";
import type { environment } from "./sandbox";
import type saveToDrive from "./tools/save_to_drive";

type SaveResult = Awaited<ReturnType<typeof saveToDrive.execute>>;
type Saved = Extract<SaveResult, { saved: true }>;
type NotSaved = Extract<SaveResult, { saved: false }>;
type OpenOptions = NonNullable<Parameters<typeof environment.open>[0]>;

describe("agent configuration types", () => {
  it("is an eve agent definition with a static AI Gateway model ID", () => {
    expectTypeOf<typeof agent>().toExtend<AgentDefinition>();
    expectTypeOf<typeof agent.model>().toBeString();
  });

  it("limits session usage with eve's callback shape", () => {
    expectTypeOf<
      typeof agent.limits.sessionUsage
    >().toExtend<SessionUsageLimit>();
    expectTypeOf<typeof agent.limits.sessionUsage>().returns.toBeBoolean();
  });
});

describe("save_to_drive types", () => {
  it("takes a path and text content", () => {
    expectTypeOf<typeof saveToDrive.execute>()
      .parameter(0)
      .toEqualTypeOf<{ content: string; path: string }>();
    expectTypeOf<typeof saveToDrive.execute>()
      .parameter(1)
      .toEqualTypeOf<ToolContext>();
  });

  it("returns a result the model can tell apart by saved and reason", () => {
    expectTypeOf<SaveResult>().toExtend<
      | { bytes: number; path: string; saved: true }
      | { message: string; reason: "invalid_path"; saved: false }
      | { reason: "drive_busy"; saved: false }
    >();
    expectTypeOf<Saved>().toExtend<{ bytes: number; path: string }>();
    expectTypeOf<Saved["reason"]>().toBeUndefined();
    expectTypeOf<NotSaved["reason"]>().toEqualTypeOf<
      "drive_busy" | "invalid_path"
    >();
    expectTypeOf<NotSaved>().not.toExtend<{ path: string }>();
  });
});

describe("Drive helper types", () => {
  it("resolves a string path to a string", () => {
    expectTypeOf<typeof resolveDrivePath>().toEqualTypeOf<
      (relative: string) => string
    >();
  });

  it("returns the write callback's result", () => {
    expectTypeOf<
      typeof withWritableDrive<{ written: number }>
    >().returns.resolves.toEqualTypeOf<{ written: number }>();
    expectTypeOf<typeof withWritableDrive<string>>()
      .parameter(0)
      .parameter(0)
      .toEqualTypeOf<DriveWorkspace>();
  });

  it("writes text or bytes and removes by path", () => {
    expectTypeOf<DriveWorkspace["writeFiles"]>()
      .parameter(0)
      .toEqualTypeOf<{ content: string | Uint8Array; path: string }[]>();
    expectTypeOf<DriveWorkspace["remove"]>()
      .parameter(0)
      .toEqualTypeOf<string[]>();
  });

  it("reports the busy session on DriveBusyError", () => {
    expectTypeOf<DriveBusyError>().toExtend<Error>();
    expectTypeOf<DriveBusyError["sessionId"]>().toBeString();
  });
});

describe("sandbox types", () => {
  it("defines the session sandbox as an eve selector", () => {
    expectTypeOf<typeof sandbox>().toEqualTypeOf<SandboxSelector>();
  });

  it("accepts a Drive snapshot mount and a deny-all network policy", () => {
    expectTypeOf<{
      mounts: { "/drive": { drive: string; mode: "snapshot" } };
      networkPolicy: "deny-all";
    }>().toExtend<OpenOptions>();
  });

  it("rejects a mount mode Vercel Sandbox doesn't have", () => {
    expectTypeOf<{
      mounts: { "/drive": { drive: string; mode: "read-only" } };
    }>().not.toExtend<OpenOptions>();
  });
});
