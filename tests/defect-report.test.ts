import { describe, expect, it } from "vitest";
import { attachmentDescription, attachmentFileName, attachmentSignature, attachmentsHtml, detectAttachment, reportHtml } from "@/lib/domain/defect-report";
import { RUNNER_NAME } from "@/lib/domain/execution";

const bytes = (...parts: Array<number[] | string>) =>
  new Uint8Array(parts.flatMap((p) => (typeof p === "string" ? [...p].map((c) => c.charCodeAt(0)) : p)));

describe("detectAttachment", () => {
  it("knows images, videos and PDFs from their first bytes, whatever they are called", () => {
    expect(detectAttachment(bytes([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a], [0, 0]), "photo.jpg")).toEqual({ kind: "image", ext: "png" });
    expect(detectAttachment(bytes([0xff, 0xd8, 0xff, 0xe0]), "x.png")).toEqual({ kind: "image", ext: "jpg" });
    expect(detectAttachment(bytes("GIF89a", [0]), "a.gif")).toEqual({ kind: "image", ext: "gif" });
    expect(detectAttachment(bytes("RIFF", [0, 0, 0, 0], "WEBPVP8 "), "a.webp")).toEqual({ kind: "image", ext: "webp" });
    expect(detectAttachment(bytes("%PDF-1.7\n"), "report")).toEqual({ kind: "file", ext: "pdf" });
    expect(detectAttachment(bytes([0, 0, 0, 0x20], "ftypisom"), "clip.bin")).toEqual({ kind: "video", ext: "mp4" });
    expect(detectAttachment(bytes([0, 0, 0, 0x14], "ftypqt  "), "clip.mov")).toEqual({ kind: "video", ext: "mov" });
    expect(detectAttachment(bytes([0x1a, 0x45, 0xdf, 0xa3, 0x9f]), "rec.webm")).toEqual({ kind: "video", ext: "webm" });
  });

  it("takes plain UTF-8 text as a log, and refuses anything else", () => {
    expect(detectAttachment(new TextEncoder().encode("12:00 ERROR Login failed\n\tat Auth\r\n"), "app.log")).toEqual({ kind: "file", ext: "log" });
    expect(detectAttachment(new TextEncoder().encode("{\"a\":1}"), "evil.exe")).toEqual({ kind: "file", ext: "txt" });
    expect(detectAttachment(bytes("MZ", [0x90, 0, 3, 0]), "setup.exe")).toBeNull();
    expect(detectAttachment(bytes([0xc3, 0x28]), "bad.txt")).toBeNull();
    expect(detectAttachment(new Uint8Array(), "empty.txt")).toBeNull();
  });
});

describe("attachment names and signature", () => {
  it("strips paths and odd characters and uses the real extension", () => {
    expect(attachmentFileName("C:\\Users\\me\\Login <bug>.PNG", "png")).toBe("Login bug.png");
    expect(attachmentFileName("../../etc/passwd", "txt")).toBe("passwd.txt");
    expect(attachmentFileName("clip.mov", "mp4")).toBe("clip.mp4");
    expect(attachmentFileName("###", "jpg")).toBe("attachment.jpg");
  });

  it("signs the file's description after its caption", () => {
    expect(attachmentDescription("  OTP screen  ", RUNNER_NAME)).toBe(`OTP screen\n${attachmentSignature(RUNNER_NAME)}`);
    expect(attachmentDescription("", RUNNER_NAME)).toBe(attachmentSignature(RUNNER_NAME));
  });
});

describe("reportHtml", () => {
  it("turns sections, lists and lines into escaped rich text", () => {
    const html = reportHtml("## What happened\nTap <Continue> & see\n\n## Steps to reproduce\n1. Open\n   Expected: shown\n\n## Failed test cases (1)\n- TC1 Login\n\nFound by Ada.");
    expect(html).toBe(
      "<p><strong>What happened</strong></p><p>Tap &lt;Continue&gt; &amp; see</p>" +
        "<p><strong>Steps to reproduce</strong></p><p>1. Open<br />&nbsp;&nbsp;&nbsp;Expected: shown</p>" +
        "<p><strong>Failed test cases (1)</strong></p><ul><li>TC1 Login</li></ul><p>Found by Ada.</p>",
    );
  });

  it("puts the files before the failed test cases, or at the end", () => {
    expect(reportHtml("## What happened\nBroken\n## Failed test cases (1)\n- TC1", "<p>FILES</p>")).toBe(
      "<p><strong>What happened</strong></p><p>Broken</p><p>FILES</p><p><strong>Failed test cases (1)</strong></p><ul><li>TC1</li></ul>",
    );
    expect(reportHtml("Old style report", "<p>FILES</p>")).toBe("<p>Old style report</p><p>FILES</p>");
  });

  it("shows images inline and links every file, escaping names and captions", () => {
    const html = attachmentsHtml(
      [
        { documentId: 5, name: "otp<1>.png", caption: "OTP \"screen\"", kind: "image" },
        { documentId: 6, name: "app.log", caption: "", kind: "file" },
      ],
      (id) => `https://x.spiraservice.net/24/Attachment/${id}.aspx`,
    );
    expect(html).toContain("<p><strong>Screenshots and files</strong></p>");
    expect(html).toContain('<img src="https://x.spiraservice.net/24/Attachment/5.aspx" alt="otp&lt;1&gt;.png"');
    expect(html).toContain('<a href="https://x.spiraservice.net/24/Attachment/5.aspx">otp&lt;1&gt;.png</a> OTP &quot;screen&quot;');
    expect(html).toContain('<a href="https://x.spiraservice.net/24/Attachment/6.aspx">app.log</a></p>');
    expect(html).not.toContain('<img src="https://x.spiraservice.net/24/Attachment/6.aspx"');
    expect(attachmentsHtml([], () => null)).toBe("");
    expect(attachmentsHtml([{ documentId: 7, name: "a.png", caption: "", kind: "image" }], () => null)).toBe("<p><strong>Screenshots and files</strong></p><p>a.png</p>");
  });
});
