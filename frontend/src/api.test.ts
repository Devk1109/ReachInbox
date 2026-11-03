import { afterEach, describe, expect, it, vi } from "vitest";
import { apiRequest } from "./api";

afterEach(() => vi.unstubAllGlobals());

describe("apiRequest", () => {
  it("sends session cookies and decodes successful JSON", async () => {
    const fetchMock = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
      expect(init?.credentials).toBe("include");
      return new Response(JSON.stringify({ value: "ok" }), { status: 200 });
    });
    vi.stubGlobal("fetch", fetchMock);

    await expect(apiRequest<{ value: string }>("/api/example")).resolves.toEqual({ value: "ok" });
  });

  it("turns API error responses into typed errors", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({
      error: { code: "SENDER_NOT_FOUND", message: "Sender not found" },
    }), { status: 404 })));

    await expect(apiRequest("/api/senders/missing")).rejects.toMatchObject({
      name: "ApiError", status: 404, code: "SENDER_NOT_FOUND", message: "Sender not found",
    });
  });
});
