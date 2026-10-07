import { afterEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";
import { HttpError } from "./auth";
import { jsonError, readJson, safeNextPath } from "./http";

const schema = z.object({ name: z.string() });

function jsonReq(body: string, headers: Record<string, string> = {}): Request {
  return new Request("https://app.test/api/x", { method: "POST", body, headers });
}

describe("jsonError", () => {
  it("maps an HttpError to its status, code and message", async () => {
    const res = jsonError(new HttpError(403, "forbidden", "Token lacks the scope."));
    expect(res.status).toBe(403);
    expect(res.headers.get("content-type")).toBe("application/json");
    expect(await res.json()).toEqual({ error: "forbidden", message: "Token lacks the scope." });
  });

  describe("server-side log", () => {
    afterEach(() => vi.restoreAllMocks());

    it("logs a 500 HttpError once, with its cause's name and message", async () => {
      const spy = vi.spyOn(console, "error").mockImplementation(() => {});
      const cause = Object.assign(new Error('relation "user_dietary_profiles" does not exist'),
        { name: "PostgrestError", code: "42P01" });
      const res = jsonError(new HttpError(500, "profile_read_failed", "Could not read profiles.", { cause }));
      expect(res.status).toBe(500);
      expect(await res.json()).toEqual({ error: "profile_read_failed", message: "Could not read profiles." });
      expect(spy).toHaveBeenCalledTimes(1);
      const line = spy.mock.calls[0].join(" ");
      expect(line).toContain("profile_read_failed");
      expect(line).toContain("PostgrestError");
      expect(line).toContain("42P01");
      expect(line).toContain('relation \\"user_dietary_profiles\\" does not exist');
    });

    it("logs a 503 HttpError that has no cause", () => {
      const spy = vi.spyOn(console, "error").mockImplementation(() => {});
      jsonError(new HttpError(503, "nous_unconfirmed", "Refused."));
      expect(spy).toHaveBeenCalledTimes(1);
      expect(spy.mock.calls[0].join(" ")).toContain("nous_unconfirmed");
    });

    it("logs a plain-object cause by its message only, never its other fields", () => {
      const spy = vi.spyOn(console, "error").mockImplementation(() => {});
      const cause = { message: "insert failed", details: "Key (email)=(someone@example.com)" };
      jsonError(new HttpError(500, "write_failed", "Could not save.", { cause }));
      const line = spy.mock.calls[0].join(" ");
      expect(line).toContain("insert failed");
      expect(line).not.toContain("someone@example.com");
    });

    it("does not log a 4xx HttpError", () => {
      const spy = vi.spyOn(console, "error").mockImplementation(() => {});
      jsonError(new HttpError(404, "not_found", "No such row.", { cause: new Error("x") }));
      expect(spy).not.toHaveBeenCalled();
    });
  });

  it("maps anything else to a generic 500", async () => {
    const res = jsonError(new Error("connection string postgres://user:secret@host"));
    expect(res.status).toBe(500);
    expect(await res.json()).toEqual({ error: "internal", message: "Something went wrong." });
  });
});

describe("readJson", () => {
  it("returns the parsed body", async () => {
    await expect(readJson(jsonReq('{"name":"oats"}'), schema, 1024)).resolves.toEqual({ name: "oats" });
  });

  it("rejects a declared content-length over the limit before reading", async () => {
    const req = jsonReq('{"name":"oats"}', { "content-length": "99999" });
    await expect(readJson(req, schema, 1024)).rejects.toMatchObject({ status: 413, code: "too_large" });
  });

  it("rejects an actual body over the limit", async () => {
    await expect(readJson(jsonReq(`{"name":"${"x".repeat(80)}"}`), schema, 32)).rejects.toMatchObject({
      status: 413,
    });
  });

  it("rejects a body that is not JSON", async () => {
    await expect(readJson(jsonReq("not json"), schema, 1024)).rejects.toMatchObject({
      status: 400,
      code: "bad_request",
    });
  });

  it("rejects a body that does not match the schema, without echoing it", async () => {
    const promise = readJson(jsonReq('{"name":42,"secret":"hunter2"}'), schema, 1024);
    await expect(promise).rejects.toMatchObject({ status: 400, code: "bad_request" });
    await promise.catch((e: HttpError) => expect(e.message).not.toContain("hunter2"));
  });
});

describe("safeNextPath", () => {
  it("keeps a root-relative path", () => {
    expect(safeNextPath("/foods?tab=eats")).toBe("/foods?tab=eats");
  });

  it("falls back to / for anything that could leave the origin", () => {
    expect(safeNextPath(null)).toBe("/");
    expect(safeNextPath("")).toBe("/");
    expect(safeNextPath("//evil.test/x")).toBe("/");
    expect(safeNextPath("/\\evil.test")).toBe("/");
    expect(safeNextPath("https://evil.test")).toBe("/");
    expect(safeNextPath("week")).toBe("/");
    expect(safeNextPath("/we\nek")).toBe("/");
  });
});
