import { defineAgent } from "eve";

/**
 * Input tokens a session can send before eve pauses it and asks whether to continue.
 *
 * @remarks Counts every input token a model call sends, including history replayed from the provider's prompt cache.
 */
const SESSION_INPUT_TOKEN_LIMIT = 300_000;

export default defineAgent({
  limits: {
    sessionUsage: ({ window }) =>
      window.inputTokens >= SESSION_INPUT_TOKEN_LIMIT,
  },
  model: "anthropic/claude-fable-5.2",
});
