import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { onLocalChange, readItem, readRaw, writeItem } from "@/lib/client/storage";
import { createStoreSync } from "@/lib/client/store-sync";
import { batchBySize, isSyncedKey, mergeActivity } from "@/lib/domain/store-sync";
import { listEntries, readItems, StoreError, writeItems } from "@/lib/server/store";

const entry = (id: string, at: string) => ({ id, at, type: "x", message: id, draftId: null, module: null, details: null });

describe("shared storage rules", () => {
  it("shares everything except this device's tester name and preferences", () => {
    expect(isSyncedKey("settings")).toBe(true);
    expect(isSyncedKey("draft:0f8e9c3a-1111-2222-3333-444455556666")).toBe(true);
    expect(isSyncedKey("report-options:24")).toBe(true);
    expect(isSyncedKey("tester")).toBe(false);
    expect(isSyncedKey("defect-auto-new-case")).toBe(false);
    expect(isSyncedKey("bad key")).toBe(false);
  });

  it("merges activity from every browser by entry, newest first", () => {
    const merged = mergeActivity([entry("a", "2026-10-01"), entry("b", "2026-10-03")], [entry("c", "2026-10-02"), entry("a", "2026-10-01")]);
    expect(merged.map((e) => e.id)).toEqual(["b", "c", "a"]);
    expect(mergeActivity(null, [entry("a", "1"), { nope: true }])).toHaveLength(1);
  });

  it("batches by size and count, sending an oversized item alone", () => {
    expect(batchBySize([5, 5, 5, 20, 1], (n) => n, 10, 10)).toEqual([[5, 5], [5], [20], [1]]);
    expect(batchBySize([1, 1, 1], (n) => n, 100, 2)).toEqual([[1, 1], [1]]);
  });
});

describe("Supabase store on the server", () => {
  let calls: Array<{ url: string; init: RequestInit }>;
  let respond: (url: string, init: RequestInit) => Response;

  beforeEach(() => {
    process.env.SUPABASE_URL = "https://example.supabase.co/";
    process.env.SUPABASE_SERVICE_ROLE_KEY = "sb_secret_test";
    calls = [];
    respond = () => Response.json([]);
    vi.stubGlobal("fetch", async (url: string, init: RequestInit) => {
      calls.push({ url, init });
      return respond(url, init);
    });
  });

  afterEach(() => {
    delete process.env.SUPABASE_URL;
    delete process.env.SUPABASE_SERVICE_ROLE_KEY;
  });

  it("upserts with the secret key in apikey only, newest write wins", async () => {
    const written = await writeItems([{ key: "settings", value: { a: 1 } }, { key: "draft:x1234567", value: null }], new Date("2026-10-12T10:00:00Z"));
    expect(written).toEqual([
      { key: "settings", updatedAt: "2026-10-12T10:00:00.000Z", merged: false },
      { key: "draft:x1234567", updatedAt: "2026-10-12T10:00:00.000Z", merged: false },
    ]);
    const [call] = calls;
    expect(call.url).toBe("https://example.supabase.co/rest/v1/app_store?on_conflict=key");
    const headers = call.init.headers as Record<string, string>;
    expect(headers.apikey).toBe("sb_secret_test");
    expect(headers.Authorization).toBeUndefined();
    expect(headers.Prefer).toContain("merge-duplicates");
    expect(JSON.parse(call.init.body as string)).toEqual([
      { key: "settings", value: { a: 1 }, deleted: false, size: 7, updated_at: "2026-10-12T10:00:00.000Z" },
      { key: "draft:x1234567", value: null, deleted: true, size: 0, updated_at: "2026-10-12T10:00:00.000Z" },
    ]);
  });

  it("sends a legacy service_role JWT as a bearer token too", async () => {
    process.env.SUPABASE_SERVICE_ROLE_KEY = "eyJhbGciOi.test";
    await listEntries();
    expect((calls[0].init.headers as Record<string, string>).Authorization).toBe("Bearer eyJhbGciOi.test");
  });

  it("merges the activity log with what is stored", async () => {
    respond = (url, init) =>
      init.method === "POST" ? new Response(null, { status: 201 }) : Response.json([{ key: "activity", value: [entry("old", "2026-10-01")], updated_at: "2026-10-01T00:00:00+00:00", deleted: false }]);
    const [written] = await writeItems([{ key: "activity", value: [entry("new", "2026-10-02")] }]);
    expect(written.merged).toBe(true);
    expect(JSON.parse(calls[1].init.body as string)[0].value.map((e: { id: string }) => e.id)).toEqual(["new", "old"]);
  });

  it("lists keys with times in one format and reads values by key", async () => {
    respond = (url) =>
      url.includes("select=key,value")
        ? Response.json([{ key: "settings", value: { a: 1 }, updated_at: "2026-10-12T10:00:00.123+00:00", deleted: false }])
        : Response.json([{ key: "settings", updated_at: "2026-10-12T10:00:00.123+00:00", deleted: false, size: 7 }]);
    expect(await listEntries()).toEqual([{ key: "settings", updatedAt: "2026-10-12T10:00:00.123Z", deleted: false, size: 7 }]);
    expect(await readItems(["settings", "draft:a1234567"])).toEqual([{ key: "settings", value: { a: 1 }, updatedAt: "2026-10-12T10:00:00.123Z", deleted: false }]);
    expect(decodeURIComponent(calls[1].url)).toContain('key=in.("settings","draft:a1234567")');
  });

  it("explains a missing table or a refused key, without the key", async () => {
    respond = () => new Response("nope", { status: 404 });
    await expect(listEntries()).rejects.toThrow(/Run supabase\/schema.sql/);
    respond = () => new Response("nope", { status: 401 });
    const refused = await listEntries().catch((error: Error) => error);
    expect(refused).toBeInstanceOf(StoreError);
    expect((refused as Error).message).toMatch(/refused the key/);
    expect((refused as Error).message).not.toContain("sb_secret_test");
    delete process.env.SUPABASE_URL;
    await expect(listEntries()).rejects.toBeInstanceOf(StoreError);
  });
});

/** A stand-in for /api/store and /api/store/read with the same rules as the server. */
function fakeServer(configured = true) {
  const rows = new Map<string, { value: unknown; updatedAt: string; deleted: boolean }>();
  let clock = Date.parse("2026-10-12T10:00:00Z");
  let failWrites = false;
  const put = (key: string, value: unknown) => {
    clock += 1000;
    rows.set(key, { value, updatedAt: new Date(clock).toISOString(), deleted: value === null });
  };
  vi.stubGlobal("fetch", async (path: string, init: RequestInit = {}) => {
    const body = init.body ? JSON.parse(init.body as string) : null;
    if (path === "/api/store" && (init.method ?? "GET") === "GET") {
      if (!configured) return Response.json({ configured: false });
      return Response.json({
        configured: true,
        entries: [...rows].map(([key, r]) => ({ key, updatedAt: r.updatedAt, deleted: r.deleted, size: JSON.stringify(r.value).length })),
      });
    }
    if (path === "/api/store" && init.method === "PUT") {
      if (failWrites) return Response.json({ error: "Supabase answered HTTP 500." }, { status: 502 });
      return Response.json({
        items: body.items.map(({ key, value }: { key: string; value: unknown }) => {
          put(key, value);
          return { key, updatedAt: rows.get(key)!.updatedAt, merged: false };
        }),
      });
    }
    if (path === "/api/store/read") {
      return Response.json({ items: body.keys.filter((k: string) => rows.has(k)).map((key: string) => ({ key, ...rows.get(key)! })) });
    }
    return Response.json({ error: "not found" }, { status: 404 });
  });
  return { rows, put, failWrites: (on: boolean) => (failWrites = on) };
}

describe("syncing this browser with the shared store", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => {
    onLocalChange(null);
    vi.useRealTimers();
  });

  function start() {
    const sync = createStoreSync({ flushDelayMs: 60_000 });
    onLocalChange(sync.markPending);
    return sync;
  }

  it("keeps data in this browser only when shared storage is not set up", async () => {
    fakeServer(false);
    const sync = start();
    writeItem("settings", { a: 1 });
    await sync.sync();
    expect(sync.state().mode).toBe("local");
    writeItem("settings", { a: 2 });
    expect(readRaw("settings")).toBe('{"a":2}');
    expect(localStorage.getItem("srs-sync:pending")).toBe("[]");
  });

  it("uploads what this browser saved before, except device-only items", async () => {
    const server = fakeServer();
    writeItem("settings", { projectId: 24 });
    writeItem("draft:abcdef12", { id: "abcdef12" });
    writeItem("tester", "Daniel");
    const sync = start();
    await sync.sync();
    expect(sync.state()).toMatchObject({ mode: "cloud", error: null });
    expect([...server.rows.keys()].sort()).toEqual(["draft:abcdef12", "settings"]);
  });

  it("loads others' changes and deletions, and keeps unsaved local edits", async () => {
    const server = fakeServer();
    server.put("draft:remote01", { id: "remote01" });
    server.put("draft:gone0001", { id: "gone0001" });
    const sync = start();
    await sync.sync();
    expect(readItem("draft:gone0001")).toEqual({ id: "gone0001" });

    server.put("draft:gone0001", null);
    server.put("settings", { from: "server" });
    writeItem("settings", { from: "here" });
    await sync.pull();
    expect(readItem("draft:remote01")).toEqual({ id: "remote01" });
    expect(readItem("draft:gone0001")).toBeNull();
    expect(readItem("settings")).toEqual({ from: "here" });

    await sync.flush();
    expect(server.rows.get("settings")!.value).toEqual({ from: "here" });
    expect(localStorage.getItem("srs-sync:pending")).toBe("[]");
  });

  it("does not bring back an item deleted elsewhere", async () => {
    const server = fakeServer();
    const sync = start();
    await sync.sync();
    writeItem("draft:old00001", { id: "old00001" });
    await sync.flush();
    server.put("draft:old00001", null);
    await sync.sync();
    expect(readItem("draft:old00001")).toBeNull();
    expect(server.rows.get("draft:old00001")!.deleted).toBe(true);
  });

  it("keeps changes queued when saving fails, and saves them later", async () => {
    const server = fakeServer();
    const sync = start();
    await sync.sync();
    server.failWrites(true);
    writeItem("settings", { v: 1 });
    await sync.flush();
    expect(sync.state().error).toMatch(/HTTP 500/);
    expect(JSON.parse(localStorage.getItem("srs-sync:pending")!)).toEqual(["settings"]);
    server.failWrites(false);
    await sync.sync();
    expect(sync.state().error).toBeNull();
    expect(server.rows.get("settings")!.value).toEqual({ v: 1 });
  });
});
