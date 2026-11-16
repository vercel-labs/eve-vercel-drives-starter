/**
 * Network guard shared by the Vitest setup and by CLI processes that tests spawn.
 *
 * @packageDocumentation
 */
import { Socket } from "node:net";

/** Message of the error thrown for an outbound connection attempt. */
export const NETWORK_REFUSED =
  "Tests can't open network connections. Replace the Vercel Sandbox or Slack call with a fixture from agent/lib/testing.";

/**
 * Makes every outbound connection attempt in this process fail.
 *
 * @remarks Every HTTP client in Node, including `fetch` and undici, connects through `Socket.connect`, so replacing it covers the Vercel Sandbox SDK and Slack requests alike.
 */
export const refuseNetworkConnections = () => {
  Socket.prototype.connect = (): never => {
    throw new Error(NETWORK_REFUSED);
  };
};
