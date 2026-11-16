import { readFile } from "node:fs/promises";
import path from "node:path";

import type { TokenUsage } from "eve";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { z } from "zod";

import agent from "./agent";
import { DRIVE_PATH } from "./lib/drive";
import { copyApp, eveInfo } from "./lib/testing/cli";
import saveToDrive from "./tools/save_to_drive";

/** The fields of `eve info --json` this suite asserts on. */
const infoSchema = z.object({
  channels: z.array(
    z.object({ method: z.string(), name: z.string(), urlPath: z.string() })
  ),
  diagnostics: z.object({ errors: z.number(), warnings: z.number() }),
  instructions: z.string(),
  model: z.string(),
  status: z.string(),
  toolInputSchemas: z.object({ root: z.record(z.string(), z.unknown()) }),
  tools: z.array(z.string()),
});

/**
 * Builds a usage record for the session usage limit.
 *
 * @param overrides - Token counts to set; the rest are zero.
 * @returns A complete usage record.
 */
const usage = (overrides: Partial<TokenUsage> = {}): TokenUsage => ({
  cacheReadTokens: 0,
  cacheWriteTokens: 0,
  inputTokens: 0,
  outputTokens: 0,
  ...overrides,
});

describe("agent configuration", () => {
  it("runs on Claude Fable 5.2 through AI Gateway", () => {
    expect(agent.model).toBe("anthropic/claude-fable-5.2");
  });

  it.each([
    [299_999, false],
    [300_000, true],
    [300_001, true],
  ])(
    "decides a window with %d input tokens has reached the limit: %s",
    (inputTokens, reached) => {
      const window = usage({ inputTokens });

      expect(agent.limits.sessionUsage({ total: window, window })).toBe(
        reached
      );
    }
  );

  it("counts input replayed from the prompt cache toward the limit", () => {
    const window = usage({ cacheReadTokens: 299_000, inputTokens: 300_000 });

    expect(agent.limits.sessionUsage({ total: window, window })).toBeTruthy();
  });

  it("doesn't limit output tokens or cost", () => {
    const window = usage({ costUsd: 1000, outputTokens: 10_000_000 });

    expect(agent.limits.sessionUsage({ total: window, window })).toBeFalsy();
  });

  it("measures the window since the last approved continuation, not the session total", () => {
    expect(
      agent.limits.sessionUsage({
        total: usage({ inputTokens: 900_000 }),
        window: usage({ inputTokens: 10 }),
      })
    ).toBeFalsy();
  });
});

describe("compiled agent", () => {
  let app: Awaited<ReturnType<typeof copyApp>>;
  let info: z.infer<typeof infoSchema>;

  beforeAll(async () => {
    app = await copyApp();
    const { code, stderr, stdout } = await eveInfo({
      cwd: app.root,
      env: { SLACK_CONNECTOR: "slack/placeholder" },
      model: agent.model,
    });
    if (code !== 0) {
      throw new Error(`eve info exited with code ${code}:\n${stderr}`);
    }
    info = infoSchema.parse(JSON.parse(stdout));
  }, 60_000);

  afterAll(async () => {
    await app.remove();
  });

  it("compiles without diagnostics", () => {
    expect(info).toMatchObject({
      diagnostics: { errors: 0, warnings: 0 },
      status: "ready",
    });
  });

  it("resolves the configured model and the system instructions", () => {
    expect(info.model).toBe(agent.model);
    expect(info.instructions).toBe("instructions.md (system)");
  });

  it("offers the model only the shell, file reading, delegation, and save_to_drive", () => {
    expect(info.tools.toSorted()).toStrictEqual([
      "agent",
      "bash",
      "read_file",
      "save_to_drive",
    ]);
  });

  it.each(["edit_file", "web_fetch", "web_search", "write_file"])(
    "disables the built-in %s tool",
    (tool) => {
      expect(info.tools).not.toContain(tool);
      expect(info.toolInputSchemas.root).not.toHaveProperty(tool);
    }
  );

  it("gives the model the save_to_drive input schema", () => {
    expect(info.toolInputSchemas.root.save_to_drive).toStrictEqual({
      additionalProperties: false,
      properties: {
        content: {
          description: "Full text content of the file.",
          type: "string",
        },
        path: {
          description:
            'Path relative to the Drive root, such as "notes/standup.md". No leading slash or "..".',
          minLength: 1,
          type: "string",
        },
      },
      required: ["content", "path"],
      type: "object",
    });
  });

  it("serves the eve HTTP channel and the Slack webhook", () => {
    const routes = info.channels.map(
      ({ method, name, urlPath }) => `${name}: ${method} ${urlPath}`
    );

    expect(new Set(info.channels.map(({ name }) => name))).toStrictEqual(
      new Set(["eve", "home", "slack"])
    );
    expect(routes).toContain("slack: POST /eve/v1/slack");
    expect(routes).toContain("eve: POST /eve/v1/session");
    expect(routes).toContain("eve: POST /eve/v1/session/:sessionId");
    expect(routes).toContain("eve: GET /eve/v1/session/:sessionId/stream");
  });

  it("fails to compile with a setup hint when SLACK_CONNECTOR is unset", async () => {
    const result = await eveInfo({ cwd: app.root, model: agent.model });

    expect(result.code).not.toBe(0);
    expect(result.stderr).toContain(
      "SLACK_CONNECTOR environment variable is not set. Set it to a value like 'slack/your-agent'."
    );
  }, 60_000);
});

describe("agent instructions", () => {
  let instructions: string;

  beforeAll(async () => {
    instructions = await readFile(
      path.join(import.meta.dirname, "instructions.md"),
      "utf-8"
    );
  });

  it.each(["bash", "read_file", "save_to_drive"])(
    "tells the model to use the enabled %s tool",
    (tool) => {
      expect(instructions).toContain(`\`${tool}\``);
    }
  );

  it.each(["edit_file", "web_fetch", "web_search", "write_file"])(
    "doesn't mention the disabled %s tool",
    (tool) => {
      expect(instructions).not.toContain(tool);
    }
  );

  it("names the Drive mount path the sandbox uses", () => {
    expect(instructions).toContain(`\`${DRIVE_PATH}\``);
  });

  it("explains the drive_busy result that save_to_drive describes", () => {
    expect(saveToDrive.description).toContain("drive_busy");
    expect(instructions).toContain("`drive_busy`");
  });
});
