import { describe, expect, it } from "vitest";

import { AlertRing, serializeAlert } from "../../src/alerts.js";

class FakeAlert {
  message() {
    return "test message";
  }
  category() {
    return 42;
  }
}

describe("alerts", () => {
  it("serialize minimal", () => {
    const d = serializeAlert(new FakeAlert());
    expect(d.type).toBe("FakeAlert");
    expect(d.message).toBe("test message");
    expect(d.category).toBe(42);
    expect(d.at).toBeDefined();
  });
  it("ring capacity", () => {
    const ring = new AlertRing(10);
    for (let i = 0; i < 15; i++) {
      ring.extend([{ type: "x", at: i, message: String(i) }]);
    }
    const recent = ring.listRecent(100);
    expect(recent).toHaveLength(10);
    expect(recent[recent.length - 1]?.message).toBe("14");
  });
});
