import { describe, expect, it } from "vitest";
import { richText } from "@/lib/domain/text";
import { htmlErrorText } from "@/lib/server/spira";

describe("Spira rich text as plain text", () => {
  it("keeps paragraphs, line breaks and list items", () => {
    expect(richText("<p>Open the app</p><p>Tap <b>Sign up</b><br/>Enter details</p>")).toBe("Open the app\nTap Sign up\nEnter details");
    expect(richText("<ul><li>BVN</li><li>NIN</li></ul>")).toBe("• BVN\n• NIN");
  });

  it("decodes entities and drops scripts and styles", () => {
    expect(richText("Tom &amp; Jerry &lt;3 &#8211; &#x2014; &nbsp;ok")).toBe("Tom & Jerry <3 – — ok");
    expect(richText("<style>p{}</style><script>alert(1)</script>Safe")).toBe("Safe");
    expect(richText("&#99999999; bad")).toBe("bad");
  });

  it("turns Spira's HTML error pages into the exception message", () => {
    const page = `<?xml version="1.0" encoding="utf-8"?><!DOCTYPE html PUBLIC "-//W3C//DTD XHTML 1.0 Transitional//EN" "x"><html xmlns="http://www.w3.org/1999/xhtml"><head><title>Request Error</title><style>BODY { color: #000000; }</style></head><body><div id="content"><p class="heading1">Request Error</p><p>The server encountered an error processing the request. The exception message is 'Transaction (Process ID 61) was deadlocked on lock resources'. See server logs for more details. The exception stack trace is: </p><p>at Inflectra.SpiraTest...</p></div></body></html>`;
    expect(htmlErrorText(page)).toBe("Transaction (Process ID 61) was deadlocked on lock resources");
    expect(htmlErrorText("<html><head><title>x</title></head><body><p>Request Error</p><p>Bad request.</p></body></html>")).toBe("Request Error Bad request.");
  });

  it("handles empty input", () => {
    expect(richText(null)).toBe("");
    expect(richText("   <p></p> ")).toBe("");
  });
});
