import { describe, expect, it, vi } from "vitest";

import {
  inboundContext,
  slackAuthor,
  slackMessage,
} from "../lib/testing/slack";

vi.hoisted(() => {
  vi.stubEnv("SLACK_CONNECTOR", "slack/test");
});

const { routeSlackMessage } = await import("./slack");

const principal = {
  attributes: { channel_id: "C123" },
  authenticator: "slack-webhook",
  issuer: "slack:T123",
  principalId: "slack:T123:U123",
  principalType: "user",
};

describe(routeSlackMessage, () => {
  it("starts a turn with a per-user Slack principal for a mention", async () => {
    await expect(
      routeSlackMessage(inboundContext({ mentioned: true }), slackMessage())
    ).resolves.toMatchObject({ auth: principal });
  });

  it("starts a turn for a DM", async () => {
    const result = await routeSlackMessage(
      inboundContext(),
      slackMessage({ raw: { channel_type: "im" } })
    );

    expect(result).toMatchObject({ auth: principal });
    expect(result).not.toHaveProperty("status");
  });

  it.each([
    ["bots", slackAuthor({ isBot: true })],
    ["the agent itself", slackAuthor({ isMe: true })],
    ["messages without a verified author", undefined],
  ])("drops %s, even when they mention the agent", async (_name, author) => {
    await expect(
      routeSlackMessage(
        inboundContext({ mentioned: true, subscribed: true }),
        slackMessage({ author, raw: { channel_type: "im", user: "U123" } })
      )
    ).resolves.toBeNull();
  });

  it("defers an unmentioned reply in a thread that has a session", async () => {
    const result = await routeSlackMessage(
      inboundContext({ subscribed: true }),
      slackMessage()
    );

    expect(result).toMatchObject({ auth: principal, status: "deferred" });
    expect(result?.guidance).toContain("no_reply");
  });

  it("defers an edit to the thread's root message", async () => {
    const message = slackMessage({ threadTs: "100.2" });
    const edit = { editedTs: "100.3", message, previousText: "before" };

    await expect(
      routeSlackMessage(inboundContext({ edit }), message)
    ).resolves.toMatchObject({ auth: principal, status: "deferred" });
  });

  it("ignores an unmentioned reply in a thread without a session", async () => {
    await expect(
      routeSlackMessage(inboundContext(), slackMessage())
    ).resolves.toBeNull();
  });

  it("ignores an unmentioned top-level message, even in a channel with sessions", async () => {
    await expect(
      routeSlackMessage(
        inboundContext({ subscribed: true }),
        slackMessage({ threadTs: "100.2" })
      )
    ).resolves.toBeNull();
  });
});
