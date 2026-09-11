/**
 * Shared timezone options. The campaign form and the workspace
 * settings use the same named list so nobody has to recall IANA
 * spelling — and so a campaign window can say exactly the zone the
 * workspace runs in.
 */
export const TIMEZONE_OPTIONS = [
  "Asia/Dubai",
  "Asia/Riyadh",
  "Asia/Karachi",
  "Asia/Kolkata",
  "Europe/London",
  "Europe/Paris",
  "America/New_York",
  "America/Los_Angeles",
  "UTC",
] as const;

export type TimezoneOption = (typeof TIMEZONE_OPTIONS)[number];
