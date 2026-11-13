import { connectSlackCredentials } from "@vercel/connect/eve";
import { defaultSlackAuth, slackChannel } from "eve/channels/slack";
import type { SlackChannelConfig } from "eve/channels/slack";

import { requireEnv } from "../lib/utils/env";

/** Guidance for a reply in a followed thread that doesn't mention the agent. */
const THREAD_GUIDANCE =
  "You are part of this Slack thread, so you see replies people send each other. This " +
  "reply doesn't mention you. Answer only if it's meant for you; otherwise call `no_reply`.";

/**
 * Decides which Slack messages start a turn.
 *
 * @param ctx - Verified inbound webhook context supplied by eve.
 * @param message - Slack message carrying user, workspace, channel, and thread identifiers.
 * @returns The sender's workspace-scoped Slack principal, or null to drop the message.
 * @remarks Bots, the agent itself, and messages without a verified author are dropped, so no message falls back to a shared principal. Mentions and DMs start a turn. Replies and edits in a thread that already has a session reach the agent deferred, with guidance to call `no_reply` when they aren't meant for it. Top-level messages still need a mention.
 */
export const routeSlackMessage: NonNullable<
  SlackChannelConfig["onMessage"]
> = async (ctx, message) => {
  if (message.author?.isBot !== false || message.author.isMe) {
    return null;
  }
  const auth = defaultSlackAuth(message, ctx);
  if (!auth) {
    return null;
  }
  if (ctx.isBotMentioned() || message.raw.channel_type === "im") {
    return { auth };
  }
  if (
    ctx.edit ||
    (message.threadTs !== message.ts && (await ctx.isSubscribed()))
  ) {
    return { auth, guidance: THREAD_GUIDANCE, status: "deferred" };
  }
  return null;
};

/**
 * Connects the agent to Slack through the Vercel Connect connector named by `SLACK_CONNECTOR`.
 *
 * @throws {@link Error} When SLACK_CONNECTOR is missing.
 * @remarks `messageContext.users` adds each human sender's Slack display and real names to the model's `<sender>` block, `message.author`, and the `full_name` auth attribute. Emails are left out. Thread history includes the replies since the agent's last reply.
 */
export default slackChannel({
  credentials: connectSlackCredentials(
    requireEnv("SLACK_CONNECTOR", "slack/your-agent")
  ),
  messageContext: { users: true },
  onMessage: routeSlackMessage,
  threadContext: { since: "last-agent-reply" },
});
