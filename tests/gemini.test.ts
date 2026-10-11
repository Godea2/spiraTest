import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { aiStatus, reviewBlockedCases, shortlistDefectCases, understandDefect, type BlockedReviewCase, type DefectSearchCase } from "@/lib/server/gemini";

const KEY = "test-key-not-real";
const cases: BlockedReviewCase[] = [
  { key: "1:1", testSetName: "Android", scenario: "Verify user can sign up with BVN", keywords: ["bvn"], allKeywords: ["bvn", "nin"] },
  { key: "1:2", testSetName: "Android", scenario: "Verify BVN is not logged in plain text", keywords: ["bvn"], allKeywords: ["bvn", "nin"] },
];

function reply(payload: unknown, status = 200) {
  const body = { status: "completed", steps: [{ type: "model_output", content: [{ type: "text", text: JSON.stringify(payload) }] }] };
  return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
}

const answer = (verdicts: unknown[], status = 200) => reply({ verdicts }, status);

const sentInput = (fetchMock: ReturnType<typeof vi.fn>) => {
  const [, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
  const body = JSON.parse(String(init.body));
  return { body, input: JSON.parse(String(body.input)) };
};

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
    // Once on the main model and once on the fallback, neither retried after a timeout.
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("rejects answers in the wrong shape", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => answer([{ key: "1:1", blocked: "yes" }])));
    await expect(reviewBlockedCases("Onboarding", cases)).rejects.toThrow(/expected format/);
  });
});

describe("Gemini fallback model", () => {
  beforeEach(() => vi.stubEnv("GEMINI_API_KEY", KEY));
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.unstubAllGlobals();
    vi.useRealTimers();
  });

  const contentReply = (payload: unknown) =>
    new Response(JSON.stringify({ candidates: [{ content: { parts: [{ text: "thinking…", thought: true }, { text: JSON.stringify(payload) }] } }] }), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
  const verdicts = [{ key: "1:1", blocked: true, confidence: "high", reason: "Needs BVN." }];

  it("asks the fallback model through generateContent when the main model fails, with the same thinking and schema", async () => {
    const fetchMock = vi.fn(async (url: string | URL) => (String(url).endsWith("/interactions") ? new Response("{}", { status: 404 }) : contentReply({ verdicts })));
    vi.stubGlobal("fetch", fetchMock);
    const out = await reviewBlockedCases("Onboarding", cases);
    expect(out.map((v) => v.key)).toEqual(["1:1"]);

    const [url, init] = fetchMock.mock.calls[1] as unknown as [string, RequestInit];
    expect(url).toBe("https://generativelanguage.googleapis.com/v1beta/models/gemini-3.6-flash:generateContent");
    const body = JSON.parse(String(init.body));
    expect(body.generationConfig.thinkingConfig).toEqual({ thinkingLevel: "low" });
    expect(body.generationConfig.responseFormat.text.mimeType).toBe("application/json");
    expect((init.headers as Record<string, string>)["x-goog-api-key"]).toBe(KEY);
    expect(String(init.body)).not.toContain(KEY);
  });

  it("asks the fallback too when the main model is slow, uses the first answer and cancels the other", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    let mainSignal: AbortSignal | undefined;
    const fetchMock = vi.fn((url: string | URL, init?: RequestInit) => {
      if (String(url).endsWith("/interactions")) {
        mainSignal = init?.signal ?? undefined;
        return new Promise<Response>((_, reject) => init?.signal?.addEventListener("abort", () => reject(new DOMException("Aborted", "AbortError"))));
      }
      return Promise.resolve(contentReply({ verdicts }));
    });
    vi.stubGlobal("fetch", fetchMock);
    const pending = reviewBlockedCases("Onboarding", cases);
    await vi.advanceTimersByTimeAsync(20_000);
    await expect(pending).resolves.toHaveLength(1);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(mainSignal?.aborted).toBe(true);
  });

  it("can be turned off, and then reports the main model's error", async () => {
    vi.stubEnv("GEMINI_FALLBACK_MODEL", "off");
    const fetchMock = vi.fn(async () => new Response("{}", { status: 404 }));
    vi.stubGlobal("fetch", fetchMock);
    await expect(reviewBlockedCases("Onboarding", cases)).rejects.toThrow(/does not know the model "gemini-3.8-flash"/);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});

describe("Gemini defect search", () => {
  beforeEach(() => vi.stubEnv("GEMINI_API_KEY", KEY));
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.unstubAllGlobals();
  });

  const reading = { feature: "Airtime purchase", related: ["top-up", "recharge"], area: "Airtime", symptom: "Purchase fails", expected: "" };

  it("works out the feature once, with its other names deduplicated, and a title even when Gemini gives none", async () => {
    const fetchMock = vi.fn(async () =>
      reply({
        feature: "Airtime purchase",
        related: ["top-up", "Top-up", "recharge", ""],
        title: "",
        area: "Airtime",
        symptom: "Buying airtime fails",
        expected: "Airtime is bought",
        severity: "high",
        question: "",
      }),
    );
    vi.stubGlobal("fetch", fetchMock);
    const analysis = await understandDefect("unable to buy airtime", [{ module: "Payments", testSets: ["Payments iOS"] }]);
    expect(analysis).toMatchObject({ feature: "Airtime purchase", related: ["top-up", "recharge"], title: "Buying airtime fails", question: null });
    const { body, input } = sentInput(fetchMock);
    expect(body.generation_config).toEqual({ thinking_level: "low" });
    expect(input.modules).toEqual([{ module: "Payments", testSets: ["Payments iOS"] }]);
  });

  it("sends cases grouped by test set with short ids, and maps the picks back to keys", async () => {
    const searchCases: DefectSearchCase[] = [
      { key: "1:1", module: "Payments", testSetName: "Payments iOS", scenario: "Verify customer can recharge a phone line" },
      { key: "1:2", module: "Payments", testSetName: "Payments iOS", scenario: "Verify session timeout" },
      { key: "2:7", module: "Transactions", testSetName: "Transactions iOS", scenario: "Airtime entry in history", workbookScenario: "Airtime entry in history" },
    ];
    const fetchMock = vi.fn(async () =>
      reply({
        picks: [
          { id: 0, relevance: "high" },
          { id: 2, relevance: "medium" },
          { id: 0, relevance: "low" },
          { id: 9, relevance: "high" },
          { id: 1.5, relevance: "high" },
        ],
      }),
    );
    vi.stubGlobal("fetch", fetchMock);
    const picks = await shortlistDefectCases("unable to buy airtime", reading, searchCases);
    expect(picks).toEqual([
      { key: "1:1", relevance: "high" },
      { key: "2:7", relevance: "medium" },
    ]);
    const { body, input } = sentInput(fetchMock);
    expect(body.generation_config).toEqual({ thinking_level: "low" });
    expect(input.defect).toMatchObject({ description: "unable to buy airtime", feature: "Airtime purchase", related: ["top-up", "recharge"] });
    expect(input.testSets).toEqual([
      { module: "Payments", testSet: "Payments iOS", cases: [{ id: 0, name: "Verify customer can recharge a phone line" }, { id: 1, name: "Verify session timeout" }] },
      { module: "Transactions", testSet: "Transactions iOS", cases: [{ id: 2, name: "Airtime entry in history" }] },
    ]);
  });
});
