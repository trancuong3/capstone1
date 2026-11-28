import { describe, expect, it } from "vitest";
import { parseVoiceIntent } from "@/lib/reading/voice-intent";

describe("parseVoiceIntent", () => {
  it("recognizes NEXT_PAGE commands with or without courtesy words", () => {
    expect(parseVoiceIntent("sang trang").type).toBe("NEXT_PAGE");
    expect(parseVoiceIntent("Cô ơi trang tiếp theo nhé").type).toBe(
      "NEXT_PAGE",
    );
    expect(parseVoiceIntent("qua trang ạ").type).toBe("NEXT_PAGE");
  });

  it("recognizes SKIP commands for retry words and comprehension questions", () => {
    expect(parseVoiceIntent("bỏ qua").type).toBe("SKIP");
    expect(parseVoiceIntent("bỏ qua từ này").type).toBe("SKIP");
    expect(parseVoiceIntent("bỏ qua câu này đi").type).toBe("SKIP");
    expect(parseVoiceIntent("từ tiếp theo").type).toBe("SKIP");
  });

  it("recognizes SPELL, REPLAY, STOP, and HELP commands in retry flows", () => {
    expect(parseVoiceIntent("đánh vần giúp con").type).toBe("SPELL");
    expect(parseVoiceIntent("nghe lại mẫu").type).toBe("REPLAY");
    expect(parseVoiceIntent("dừng lại").type).toBe("STOP");
    expect(parseVoiceIntent("dừng luyện").type).toBe("STOP");
    expect(parseVoiceIntent("con không biết đọc").type).toBe("HELP");
  });

  it("keeps reading-text precedence when the upcoming text itself matches the phrase", () => {
    expect(
      parseVoiceIntent("sang trang", { upcomingText: "bé sang trang mới" })
        .type,
    ).toBe("NONE");
    expect(
      parseVoiceIntent("bỏ qua", { upcomingText: "bỏ qua bụi cây" }).type,
    ).toBe("NONE");
  });

  it("yields STOP to upcomingText when the book text mentions dừng lại", () => {
    expect(
      parseVoiceIntent("dừng lại", { upcomingText: "xe dừng lại" }),
    ).toEqual({ type: "NONE", reason: "in-book" });
  });
});
