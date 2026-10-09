import { test } from "node:test";
import assert from "node:assert/strict";
import { inQuietHours } from "@/lib/local-time";

const TZ = "America/Chicago";
const on = { crawlerQuietHoursEnabled: true, crawlerQuietStartHour: 21, crawlerQuietEndHour: 7 };

/** A UTC instant for a given local hour in Chicago during CDT (UTC-5). */
const atLocalHour = (hour: number) => new Date(Date.UTC(2026, 9, 7, (hour + 5) % 24, 30));

test("the overnight window wraps midnight", () => {
  for (const hour of [21, 22, 23, 0, 3, 6]) {
    assert.equal(inQuietHours(atLocalHour(hour), on, TZ), true, `${hour}:30 local should be quiet`);
  }
  for (const hour of [7, 9, 12, 17, 20]) {
    assert.equal(inQuietHours(atLocalHour(hour), on, TZ), false, `${hour}:30 local should alert`);
  }
});

test("the boundary hours behave as documented", () => {
  // Start is inclusive, end is exclusive, so 07:00 is the first alerting hour.
  assert.equal(inQuietHours(atLocalHour(21), on, TZ), true);
  assert.equal(inQuietHours(atLocalHour(7), on, TZ), false);
});

test("a daytime window that does not wrap still works", () => {
  const daytime = { crawlerQuietHoursEnabled: true, crawlerQuietStartHour: 9, crawlerQuietEndHour: 17 };
  assert.equal(inQuietHours(atLocalHour(12), daytime, TZ), true);
  assert.equal(inQuietHours(atLocalHour(8), daytime, TZ), false);
  assert.equal(inQuietHours(atLocalHour(17), daytime, TZ), false);
});

test("quiet hours can be switched off entirely", () => {
  const off = { ...on, crawlerQuietHoursEnabled: false };
  assert.equal(inQuietHours(atLocalHour(2), off, TZ), false);
});

test("an equal start and end means no quiet window", () => {
  // Otherwise this would read as a 24-hour window and silence every alert.
  const same = { crawlerQuietHoursEnabled: true, crawlerQuietStartHour: 0, crawlerQuietEndHour: 0 };
  for (const hour of [0, 6, 13, 23]) {
    assert.equal(inQuietHours(atLocalHour(hour), same, TZ), false);
  }
});

test("the window follows local time, not UTC", () => {
  // 02:30 UTC is 21:30 the previous day in Chicago, which is inside the window.
  assert.equal(inQuietHours(new Date("2026-10-08T02:30:00Z"), on, TZ), true);
  // The same instant is daytime in Tokyo, which is not.
  assert.equal(inQuietHours(new Date("2026-10-08T02:30:00Z"), on, "Asia/Tokyo"), false);
});
