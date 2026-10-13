import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

const { attachDocument, createIncident, deleteAttachedDocument, uploadDocument, SPIRA_ENV } = await import("@/lib/server/spira");
const { attachmentSignature } = await import("@/lib/domain/defect-report");
const { RUNNER_NAME } = await import("@/lib/domain/execution");

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });

describe("Spira documents", () => {
  beforeEach(() => {
    vi.stubEnv(SPIRA_ENV.baseUrl, "https://example.spiraservice.net");
    vi.stubEnv(SPIRA_ENV.username, "tester");
    vi.stubEnv(SPIRA_ENV.apiKey, "not-a-real-key");
  });
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.unstubAllGlobals();
  });

  it("uploads a file as base64, attached to the incident and runs, with its signed description", async () => {
    const fetch = vi.fn(async () => json({ AttachmentId: 321 }));
    vi.stubGlobal("fetch", fetch);
    const id = await uploadDocument(24, {
      name: "otp.png",
      description: `OTP <screen>\n${attachmentSignature(RUNNER_NAME)}`,
      data: "iVBORw0KGgo=",
      size: 8,
      artifacts: [
        { artifactId: 77, artifactTypeId: 3 },
        { artifactId: 901, artifactTypeId: 5 },
      ],
    });
    expect(id).toBe(321);
    const [url, init] = fetch.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe("https://example.spiraservice.net/Services/v7_0/RestService.svc/projects/24/documents/file");
    expect(init.method).toBe("POST");
    expect(JSON.parse(String(init.body))).toEqual({
      AttachmentTypeId: 1,
      FilenameOrUrl: "otp.png",
      Description: `OTP &lt;screen&gt;<br />${attachmentSignature(RUNNER_NAME)}`,
      BinaryData: "iVBORw0KGgo=",
      Size: 8,
      AttachedArtifacts: [
        { ArtifactId: 77, ArtifactTypeId: 3 },
        { ArtifactId: 901, ArtifactTypeId: 5 },
      ],
    });
  });

  it("attaches an existing file to an incident, where Spira answers with an empty body", async () => {
    const fetch = vi.fn(async () => new Response("", { status: 200 }));
    vi.stubGlobal("fetch", fetch);
    await expect(attachDocument(24, 3, 77, 321)).resolves.toBeUndefined();
    expect(String((fetch.mock.calls[0] as unknown as [string])[0])).toContain("/projects/24/artifact-types/3/artifacts/77/documents/321");
  });

  it("deletes only files carrying the signature", async () => {
    const calls: string[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string, init?: RequestInit) => {
        calls.push(`${init?.method} ${url.replace(/^.*RestService\.svc\//, "")}`);
        if (url.endsWith("/documents/1")) return json({ AttachmentId: 1, FilenameOrUrl: "a.png", Description: `<p>x<br />${attachmentSignature(RUNNER_NAME)}</p>` });
        if (url.endsWith("/documents/2")) return json({ AttachmentId: 2, FilenameOrUrl: "b.png", Description: "Uploaded by hand" });
        return new Response(null, { status: 204 });
      }),
    );
    await deleteAttachedDocument(24, 1);
    await expect(deleteAttachedDocument(24, 2)).rejects.toThrow(/not added by this app/);
    expect(calls).toEqual(["GET projects/24/documents/1", "DELETE projects/24/documents/1", "GET projects/24/documents/2"]);
  });

  it("writes the incident's sections and files as rich text", async () => {
    const fetch = vi.fn(async () => json({ IncidentId: 77 }));
    vi.stubGlobal("fetch", fetch);
    await createIncident(24, {
      name: "Login: Continue enabled",
      description: "## What happened\nContinue is enabled\n\n## Failed test cases (1)\n- TC1 Login",
      filesHtml: "<p>FILES</p>",
      typeId: null,
      priorityId: null,
      severityId: null,
      releaseId: 5,
      testRunStepIds: [9010],
    });
    const body = JSON.parse(String((fetch.mock.calls[0] as unknown as [string, RequestInit])[1].body));
    expect(body.Description).toBe(
      "<p><strong>What happened</strong></p><p>Continue is enabled</p><p>FILES</p><p><strong>Failed test cases (1)</strong></p><ul><li>TC1 Login</li></ul>",
    );
  });
});
