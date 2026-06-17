// ---------------------------------------------------------------------------
// Unit tests for the shared pay-cycle resolver, focused on the +1 day
// post-payday offset: payday is the LAST day of the closing cycle, and the
// day after payday is day 1 of the new cycle.
//
// June 2026 calendar anchors used below: 2026-06-03 and 2026-06-17 are
// Wednesdays (paydays); 2026-06-04 and 2026-06-18 are the Thursdays that
// open each cycle.
// ---------------------------------------------------------------------------
import { describe, it, expect } from "vitest";
import {
  resolveCurrentCycleStart,
  CYCLE_LENGTH_DAYS,
  CYCLE_ANCHOR_OFFSET_DAYS,
} from "./index.js";

const MS_PER_DAY = 86_400_000;
const ymd = (d: Date) => d.toISOString().slice(0, 10);
const at = (s: string) => new Date(s + "T00:00:00Z");

/** 1-based day within the cycle, matching the call sites' formula. */
function dayOfCycle(today: Date, cycleStart: Date): number {
  return Math.floor((today.getTime() - cycleStart.getTime()) / MS_PER_DAY) + 1;
}

describe("resolveCurrentCycleStart — +1 day post-payday offset", () => {
  // Anchor = the previous observed payday (Wed 3 Jun); money for the 17th
  // hasn't settled/imported yet, which is the real-world state.
  const anchor = "2026-06-03";

  it("on payday itself (Wed) → day 14, the LAST day of the closing cycle", () => {
    const today = at("2026-06-17");
    const start = resolveCurrentCycleStart(today, anchor);
    expect(ymd(start)).toBe("2026-06-04"); // cycle runs 4 Jun → 17 Jun
    expect(dayOfCycle(today, start)).toBe(14);
    const end = new Date(start.getTime() + (CYCLE_LENGTH_DAYS - 1) * MS_PER_DAY);
    expect(ymd(end)).toBe("2026-06-17");
  });

  it("on payday+1 (Thu) → day 1 of the new cycle", () => {
    const today = at("2026-06-18");
    const start = resolveCurrentCycleStart(today, anchor);
    expect(ymd(start)).toBe("2026-06-18"); // new cycle runs 18 Jun → 1 Jul
    expect(dayOfCycle(today, start)).toBe(1);
  });

  it("midway through the cycle (Mon) → correct dayOfCycle", () => {
    const today = at("2026-06-08"); // Monday
    const start = resolveCurrentCycleStart(today, anchor);
    expect(ymd(start)).toBe("2026-06-04");
    expect(dayOfCycle(today, start)).toBe(5); // Thu=1,Fri=2,Sat=3,Sun=4,Mon=5
  });

  it("handles an anchor that lands today (seed pushed into the future)", () => {
    // If the salary for the 17th *were* on file, anchor=17th, seed=18th
    // (future). Floor division must still resolve to the current cycle start
    // (4 Jun), not the future seed. Proves the fix isn't a forward-only walk.
    const today = at("2026-06-17");
    const start = resolveCurrentCycleStart(today, "2026-06-17");
    expect(ymd(start)).toBe("2026-06-04");
    expect(dayOfCycle(today, start)).toBe(14);
  });

  it("day-of-week fallback (no anchor) starts the day after the payday DOW", () => {
    // No biweekly inflow → fall back to (Wednesday + 1) = Thursday.
    const today = at("2026-06-17"); // Wednesday
    const start = resolveCurrentCycleStart(today, null);
    expect(ymd(start)).toBe("2026-06-11"); // most recent Thursday on/before today
    expect(start.getUTCDay()).toBe(4); // Thursday
  });

  it("offsetDays:0 reproduces the old payday-is-day-1 behaviour", () => {
    const today = at("2026-06-17");
    const start = resolveCurrentCycleStart(today, anchor, { offsetDays: 0 });
    expect(ymd(start)).toBe("2026-06-17"); // payday is day 1 again
    expect(dayOfCycle(today, start)).toBe(1);
  });

  it("ships with a +1 day offset by default", () => {
    expect(CYCLE_ANCHOR_OFFSET_DAYS).toBe(1);
  });
});
