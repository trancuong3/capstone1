import { describe, expect, it } from "vitest";
import {
  INTERACTIVE_PROMPT_BANKS,
  InteractivePromptSelector,
  type PromptCategory,
} from "@/lib/reading/interactive-prompts";

describe("InteractivePromptSelector (G23)", () => {
  it("rotates prompts without repeating the same sentence twice in a row", () => {
    const selector = new InteractivePromptSelector();
    const categories = Object.keys(
      INTERACTIVE_PROMPT_BANKS,
    ) as PromptCategory[];

    for (const category of categories) {
      const first = selector.next(category, { sentence: "Tôi ăn cơm." });
      const second = selector.next(category, { sentence: "Tôi ăn cơm." });
      expect(first.trim().length).toBeGreaterThan(0);
      expect(second.trim().length).toBeGreaterThan(0);
      if (INTERACTIVE_PROMPT_BANKS[category].length >= 2) {
        expect(second).not.toBe(first);
      }
    }
  });

  it("substitutes the sentence placeholder cleanly for reinforcement prompts", () => {
    const selector = new InteractivePromptSelector();
    const afterFixed = selector.next("sentenceReinforceAfterSuccess", {
      sentence: "Tôi ăn cơm.",
    });
    const afterHelped = selector.next("sentenceReinforceAfterHelp", {
      sentence: "Tôi ăn cơm.",
    });
    expect(afterFixed).toContain("Tôi ăn cơm.");
    expect(afterHelped).toContain("Tôi ăn cơm.");
    expect(afterFixed).not.toContain("{sentence}");
    expect(afterHelped).not.toContain("{sentence}");
  });

  it("throttles optional praise so it never chatters or interrupts the child", () => {
    const selector = new InteractivePromptSelector();
    const t0 = 10_000;
    expect(selector.nextIfAllowed("spelledOutPraise", t0)).not.toBeNull();
    // 5 seconds later -> throttled (25s cooldown)
    expect(selector.nextIfAllowed("spelledOutPraise", t0 + 5_000)).toBeNull();
    // 30 seconds later -> allowed again with a different phrase
    const later = selector.nextIfAllowed("spelledOutPraise", t0 + 30_000);
    expect(later).not.toBeNull();
  });
});
