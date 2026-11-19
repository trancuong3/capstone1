import { describe, expect, it } from "vitest";
import { isWordHelpRequest } from "@/lib/reading/word-help";

describe("Vietnamese reading help", () => {
  it.each([
    "Con không biết đọc.",
    "Con không biết",
    "Con chưa biết từ này",
    "Cô ơi, con không biết đọc chữ này ạ.",
  ])("recognizes a complete request: %s", (text) => {
    expect(isWordHelpRequest(text.normalize("NFD"), "thức")).toBe(true);
  });
  it.each([
    ["Con không biết", "Con không biết hôm nay trời mưa."],
    ["Con không biết hôm nay trời mưa", "thức"],
    ["thực", "thức"],
  ])("keeps ordinary reading: %s", (text, target) => {
    expect(isWordHelpRequest(text, target)).toBe(false);
  });
});
