import { describe, expect, it } from "vitest";

import {
  type PoolState,
  emptyPool,
  moveInOrder,
  nameFromEmail,
  nextUsable,
  parseResetMs,
  validateName,
} from "./pool.js";

const QUOTA_A =
  "Internal error: agy failed: Error: Individual quota reached. Please upgrade your subscription to increase your limits. Resets in 2h51m28s.";
const QUOTA_B =
  'Internal error: agy failed: error: Individual quota reached. Resets in 44m59s.\nAGY_ERROR: {"short_error":"RESOURCE_EXHAUSTED (code 429): Individual q';

function pool(active: string | null, exhausted: Record<string, number> = {}): PoolState {
  const order = ["a", "b", "c"];
  return {
    order,
    active,
    lastSwitchAt: 0,
    accounts: Object.fromEntries(
      order.map((name) => [
        name,
        { name, email: `${name}@x`, key: name, addedAt: 0, exhaustedUntil: exhausted[name] ?? 0, lastError: null, lastActivatedAt: null },
      ]),
    ),
  };
}

describe("parseResetMs", () => {
  it("parses agy and generic reset times", () => {
    expect(parseResetMs(QUOTA_A)).toBe((2 * 3600 + 51 * 60 + 28) * 1000);
    expect(parseResetMs(QUOTA_B)).toBe((44 * 60 + 59) * 1000);
    expect(parseResetMs("Resets in 3d")).toBe(3 * 86_400_000);
    expect(parseResetMs("Rate limit reached, try again in 2h")).toBe(2 * 3_600_000);
    expect(parseResetMs("quota reached")).toBeNull();
  });
});

describe("nextUsable", () => {
  it("rotates past the active account and wraps", () => {
    expect(nextUsable(pool("a"), 10)).toBe("b");
    expect(nextUsable(pool("c"), 10)).toBe("a");
  });

  it("skips exhausted accounts", () => {
    expect(nextUsable(pool("a", { a: 100, b: 100 }), 10)).toBe("c");
  });

  it("returns null when every account is out", () => {
    expect(nextUsable(pool("a", { a: 100, b: 100, c: 100 }), 10)).toBeNull();
  });

  it("brings an account back once its reset passes", () => {
    expect(nextUsable(pool("a", { a: 100, b: 5, c: 100 }), 10)).toBe("b");
  });

  it("starts from the first account when none is active", () => {
    expect(nextUsable(pool(null), 10)).toBe("a");
  });
});

describe("validateName", () => {
  it("normalizes and rejects bad names", () => {
    expect(validateName(" Work ")).toBe("work");
    expect(() => validateName("../x")).toThrow();
    expect(() => validateName(undefined)).toThrow();
  });
});

describe("nameFromEmail", () => {
  it("slugs the local part and avoids clashes", () => {
    expect(nameFromEmail("Jane.Doe+ai@gmail.com", [])).toBe("jane-doe-ai");
    expect(nameFromEmail("a@x.com", ["a", "a-2"])).toBe("a-3");
    expect(nameFromEmail(null, [])).toBe("account");
  });
});

describe("moveInOrder", () => {
  it("swaps neighbours and ignores the edges", () => {
    expect(moveInOrder(["a", "b", "c"], "b", "up")).toEqual(["b", "a", "c"]);
    expect(moveInOrder(["a", "b", "c"], "b", "down")).toEqual(["a", "c", "b"]);
    expect(moveInOrder(["a", "b"], "a", "up")).toEqual(["a", "b"]);
  });
});

describe("emptyPool", () => {
  it("returns independent pools", () => {
    const a = emptyPool();
    a.order.push("x");
    expect(emptyPool().order).toEqual([]);
  });
});
