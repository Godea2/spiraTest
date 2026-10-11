import { describe, expect, it } from "vitest";
import { richText } from "@/lib/domain/text";

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

  it("handles empty input", () => {
    expect(richText(null)).toBe("");
    expect(richText("   <p></p> ")).toBe("");
  });
});
