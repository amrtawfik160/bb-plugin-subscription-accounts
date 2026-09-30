import { describe, expect, it } from "vitest";
import { poolQuotaMetrics } from "./pooler";

describe("pool quota compatibility", () => {
  it("keeps reported Codex windows when the legacy fields are null", () => {
    const metrics = poolQuotaMetrics({
      fiveHourUtilization: null,
      sevenDayUtilization: null,
      limitWindows: [
        {
          slot: "primary",
          windowMinutes: 10080,
          utilization: 0.1,
          resetAt: 123,
        },
        {
          slot: "secondary",
          windowMinutes: 300,
          utilization: 0.2,
          resetAt: 456,
        },
      ],
    });
    expect(metrics).toMatchObject([
      { label: "Weekly window", used: 10, resetAt: 123 },
      { label: "5-hour window", used: 20, resetAt: 456 },
    ]);
  });

  it("does not invent a session when Codex only reports a weekly allowance", () => {
    expect(
      poolQuotaMetrics({
        limitWindows: [
          {
            slot: "primary",
            windowMinutes: 10080,
            utilization: 0,
            resetAt: 123,
          },
        ],
      }),
    ).toMatchObject([{ label: "Weekly window", used: 0 }]);
  });
});
