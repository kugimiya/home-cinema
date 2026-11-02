import { describe, expect, it } from "vitest";

import { clientSessionSettings } from "../../src/client-identity.js";

describe("clientSessionSettings", () => {
  it("empty", () => {
    expect(clientSessionSettings({})).toEqual({});
  });
  it("user agent", () => {
    const ident = clientSessionSettings({ userAgent: "home-cinema/1.0" });
    expect(ident.user_agent).toBe("home-cinema/1.0");
    expect(ident.handshake_client_version).toBe("home-cinema 1.0");
  });
});
