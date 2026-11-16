/**
 * Preload for the command-line processes that tests spawn. It refuses every
 * network connection, and answers the one request `eve info` makes, for AI
 * Gateway's model catalog, from the `TEST_MODEL_CATALOG` variable, so
 * compiling the agent in a test needs no network.
 *
 * @remarks Runs under plain Node type stripping through `node --import`, so it imports local files with explicit `.ts` extensions.
 * @packageDocumentation
 */
import { refuseNetworkConnections } from "./network.ts";

const CATALOG_URL = "https://ai-gateway.vercel.sh/v1/models/catalog";
const catalog = process.env.TEST_MODEL_CATALOG;

refuseNetworkConnections();

const networkFetch = globalThis.fetch;
globalThis.fetch = async (input, init) => {
  const url = input instanceof Request ? input.url : String(input);
  return url === CATALOG_URL && catalog !== undefined
    ? new Response(catalog, { headers: { "content-type": "application/json" } })
    : await networkFetch(input, init);
};
