import { describe, expect, it } from "vitest";
import { validateSession } from "../src/auth";

describe("validateSession", () => {
  it("rejects expired sessions", () => {
    expect(validateSession({ id: "1", userId: "u", expiresAt: 0 })).toBe(false);
  });
});
