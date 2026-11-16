/**
 * Vitest setup that keeps the suite deterministic: every test file starts
 * from the template's default configuration, and any attempt to reach the
 * network fails instead of depending on live services.
 *
 * @remarks The deleted variables are the ones the template reads, so a developer's shell can't change test results.
 * @packageDocumentation
 */
import { refuseNetworkConnections } from "./network";

delete process.env.DRIVE_NAME;
delete process.env.DRIVE_REGION;
delete process.env.SLACK_CONNECTOR;
delete process.env.SLACK_IDENTITY_EXCLUDED_USER_IDS;

refuseNetworkConnections();
