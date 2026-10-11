import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { aiStatus, reviewBlockedCases, type BlockedReviewCase } from "@/lib/server/gemini";

const KEY = "test-key-not-real";
const cases: BlockedReviewCase[] = [
  { key: "1:1", testSetName: "Android", scenario: "Verify user can sign up with BVN", keywords: ["bvn"], allKeywords: ["bvn", "nin"] },
  { key: "1:2", testSetName: "Android", scenario: "Verify BVN is not logged in plain text", keywords: ["bvn"], allKeywords: ["bvn", "nin"] },
];

function answer(verdicts: unknown[], status = 200) {
  const body = { status: "completed", steps: [{ type: "model_output", content: [{ type: "text", text: JSON.stringify({ verdicts }) }] }] };
  return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
}

describe("Gemini blocked review", () => {
  beforeEach(() => vi.stubEnv("GEMINI_API_KEY", KEY));
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.unstubAllGlobals();
  });

  it("reports configuration without the key", () => {
    expect(aiStatus()).toEqual({ configured: true, model: "gemini-3.8-flash" });
    vi.stubEnv("GEMINI_API_KEY", "");
    vi.stubEnv("GEMINI_MODEL", "custom-model");
    expect(aiStatus()).toEqual({ configured: false, model: "custom-model" });
  });

  it("sends scenarios with the key in a header and keeps one verdict per requested case", async () => {
    const fetchMock = vi.fn(async () =>
      answer([
        { key: "1:1", blocked: true, confidence: "high", reason: "Sign-up depends on BVN." },
        { key: "1:2", blocked: false, confidence: "high", reason: "Tests logging, not BVN." },
        { key: "1:2", blocked: true, confidence: "low", reason: "Duplicate." },
        { key: "9:9", blocked: true, confidence: "high", reason: "Not asked for." },
      ]),
    );
    vi.stubGlobal("fetch", fetchMock);

    const verdicts = await reviewBlockedCases("Onboarding", cases);
    expect(verdicts.map((v) => [v.key, v.blocked])).toEqual([
      ["1:1", true],
      ["1:2", false],
    ]);

    const [, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect((init.headers as Record<string, string>)["x-goog-api-key"]).toBe(KEY);
    expect(String(init.body)).not.toContain(KEY);
    expect(JSON.parse(String(init.body))).toMatchObject({ store: false, model: "gemini-3.8-flash" });
  });

  it("refuses to run without a key and explains bad keys", async () => {
    vi.stubEnv("GEMINI_API_KEY", "");
    await expect(reviewBlockedCases("Onboarding", cases)).rejects.toThrow(/not configured/);

    vi.stubEnv("GEMINI_API_KEY", KEY);
    vi.stubGlobal("fetch", vi.fn(async () => new Response("{}", { status: 403 })));
    await expect(reviewBlockedCases("Onboarding", cases)).rejects.toThrow(/refused the API key/);
  });

  it("keeps only features from the case's keyword list, and none when not blocked", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        answer([
          { key: "1:1", blocked: true, confidence: "medium", reason: "New-customer path needs NIN.", features: ["NIN", "facial scan"] },
          { key: "1:2", blocked: false, confidence: "high", reason: "Logging only.", features: ["bvn"] },
        ]),
      ),
    );
    const verdicts = await reviewBlockedCases("Onboarding", cases);
    expect(verdicts.map((v) => [v.key, v.features])).toEqual([
      ["1:1", ["nin"]],
      ["1:2", []],
    ]);
  });

  it("sends the scenario fields the instructions refer to", async () => {
    const fetchMock = vi.fn(async () => answer([]));
    vi.stubGlobal("fetch", fetchMock);
    await reviewBlockedCases("Onboarding", cases);
    const [, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    const input = String(JSON.parse(String(init.body)).input);
    expect(input).toContain('"mentionedKeywords"');
    expect(input).toContain('"notImplemented"');
  });

  it("gives up with a clear message when Gemini times out, without retrying past the budget", async () => {
    const fetchMock = vi.fn(async () => {
      throw new DOMException("The operation timed out.", "TimeoutError");
    });
    vi.stubGlobal("fetch", fetchMock);
    await expect(reviewBlockedCases("Onboarding", cases)).rejects.toThrow(/answering slowly/);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("rejects answers in the wrong shape", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => answer([{ key: "1:1", blocked: "yes" }])));
    await expect(reviewBlockedCases("Onboarding", cases)).rejects.toThrow(/expected format/);
  });
});
