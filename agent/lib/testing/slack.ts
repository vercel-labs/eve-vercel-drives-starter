/**
 * Typed Slack fixtures for unit tests, built against eve's public Slack types
 * so fixture drift after an eve upgrade fails typecheck instead of passing
 * silently through a cast.
 *
 * @packageDocumentation
 */
import type {
  SlackAuthor,
  SlackInboundMessageContext,
  SlackMessage,
} from "eve/channels/slack";

const unsupported = (name: string) => (): never => {
  throw new Error(`This test does not provide ${name}.`);
};

/**
 * Builds the author eve derives for a human Slack user.
 *
 * @param overrides - Author properties to replace for the scenario under test.
 * @returns A verified human author with user ID `U123`.
 */
export const slackAuthor = (
  overrides: Partial<SlackAuthor> = {}
): SlackAuthor => ({
  fullName: undefined,
  isBot: false,
  isMe: false,
  userId: "U123",
  userName: undefined,
  ...overrides,
});

/**
 * Builds a complete inbound Slack message matching eve's public webhook contract.
 *
 * @param overrides - Message properties to replace for the scenario under test.
 * @returns A human-authored thread reply with stable channel, workspace, and thread identifiers.
 */
export const slackMessage = (
  overrides: Partial<SlackMessage> = {}
): SlackMessage => {
  const text = overrides.text ?? "";
  return {
    attachments: [],
    author: slackAuthor(),
    channelId: "C123",
    markdown: text,
    raw: {},
    teamId: "T123",
    text,
    threadTs: "100.1",
    ts: "100.2",
    ...overrides,
  };
};

interface InboundContextOptions {
  edit?: SlackInboundMessageContext["edit"];
  mentioned?: boolean;
  subscribed?: boolean;
}

/**
 * Builds the context supplied to Slack inbound message hooks.
 *
 * @param options - Whether the message mentions the agent, whether its thread has a session, and the edit being decided.
 * @returns Routing context whose Slack API, thread, and session methods fail when unexpectedly called.
 */
export const inboundContext = ({
  edit,
  mentioned = false,
  subscribed = false,
}: InboundContextOptions = {}): SlackInboundMessageContext => ({
  cancel: unsupported("session cancellation"),
  clear: unsupported("session clearing"),
  compact: unsupported("session compaction"),
  edit,
  end: unsupported("ending the session"),
  isBotMentioned: () => mentioned,
  isDMOrPrivateChannel: unsupported("conversation type checks"),
  isSubscribed: async () => await Promise.resolve(subscribed),
  openCodeChannel: unsupported("code channels"),
  resolveSession: unsupported("session resolution"),
  respond: unsupported("input responses"),
  send: unsupported("session sends"),
  slack: {
    channelId: "C123",
    codeChannel: false,
    request: unsupported("Slack API calls"),
    teamId: "T123",
    threadTs: "100.1",
    uploadFiles: unsupported("file uploads"),
  },
  thread: {
    listParticipants: unsupported("participant lists"),
    mentionUser: (userId) => `<@${userId}>`,
    post: unsupported("thread posts"),
    postDirectMessage: unsupported("DMs"),
    postEphemeral: unsupported("ephemeral posts"),
    recentMessages: [],
    refresh: unsupported("thread refresh"),
    startTyping: unsupported("typing status"),
  },
});
