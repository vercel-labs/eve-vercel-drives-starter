import http from "node:http";

import { describe, expect, it } from "vitest";

import { NETWORK_REFUSED } from "./network";

describe("test environment", () => {
  it.each(["https://api.vercel.com/", "http://127.0.0.1:8080/"])(
    "refuses a fetch to %s",
    async (url) => {
      await expect(fetch(url)).rejects.toHaveProperty(
        "cause.message",
        NETWORK_REFUSED
      );
    }
  );

  it("refuses a node:http request", () => {
    expect(() => http.get("http://slack.com/api/users.info")).toThrow(
      NETWORK_REFUSED
    );
  });

  it.each([
    "DRIVE_NAME",
    "DRIVE_REGION",
    "SLACK_CONNECTOR",
    "SLACK_IDENTITY_EXCLUDED_USER_IDS",
  ])("starts each test file without %s", (name) => {
    expect(process.env[name]).toBeUndefined();
  });
});
