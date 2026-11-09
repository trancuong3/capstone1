import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";

import { ComprehensionQuestion } from "@/components/reading/comprehension-question";
import type { ReadingServices } from "@/hooks/use-reading-services";
import {
  childFixture,
  TEST_SESSION_ID,
} from "@/test/fixtures/report-data-fixture";
import type { ComprehensionQuestionViewModelUI } from "@/types/reading";

const { servicesHook } = vi.hoisted(() => ({
  servicesHook: vi.fn<() => ReadingServices>(),
}));
vi.mock("@/hooks/use-reading-services", () => ({
  useReadingServices: servicesHook,
}));

function view(
  position: number,
  total: number,
  prompt: string,
): ComprehensionQuestionViewModelUI {
  return {
    question: {
      id: `80000000-0000-4000-8000-00000000000${position}`,
      type: "FACTUAL",
      prompt,
      page_revision_id: "70000000-0000-4000-8000-000000000001",
      source_span: {
        start_word_index: 0,
        end_word_index_exclusive: 3,
        sentence_index: null,
      },
      difficulty: 1,
      answered: false,
    },
    progress_label: `Câu ${position}/${total}`,
    choices: [
      { id: "A", label: "Đúng", value: "Đúng" },
      { id: "B", label: "Sai", value: "Sai" },
    ],
    position,
    total,
  };
}

function setup(questions: ComprehensionQuestionViewModelUI[]) {
  const getQuestion = vi.fn();
  questions.forEach((question) => getQuestion.mockResolvedValueOnce(question));
  const submitAnswer = vi
    .fn()
    .mockImplementation(
      async (_session: string, questionId: string, answer: string) => ({
        answer_id: "90000000-0000-4000-8000-000000000001",
        question_id: questionId,
        submitted_answer: answer,
        is_correct: answer === "Đúng",
        score: answer === "Đúng" ? 1 : 0,
        feedback_code: answer === "Đúng" ? "CORRECT" : "TRY_AGAIN",
      }),
    );
  servicesHook.mockReturnValue({
    comprehensionService: { getQuestion, submitAnswer },
  } as unknown as ReadingServices);
  const onComplete = vi.fn();
  render(
    <ComprehensionQuestion
      child={childFixture}
      onComplete={onComplete}
      sessionId={TEST_SESSION_ID}
    />,
  );
  return { getQuestion, submitAnswer, onComplete };
}

describe("AI tutor question flow", () => {
  it("walks through every generated question and then completes the session", async () => {
    const user = userEvent.setup();
    const { getQuestion, onComplete } = setup([
      view(1, 2, "Câu hỏi thứ nhất?"),
      view(2, 2, "Câu hỏi thứ hai?"),
    ]);

    expect(await screen.findByText("Câu hỏi thứ nhất?")).toBeInTheDocument();
    expect(screen.getByText("Câu 1/2")).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: /Sai/ }));
    expect(
      await screen.findByText("Gần đúng rồi, thử lại nhé."),
    ).toBeInTheDocument();
    expect(onComplete).not.toHaveBeenCalled();

    await user.click(screen.getByRole("button", { name: /Đúng/ }));
    await user.click(
      await screen.findByRole("button", { name: /Câu tiếp theo/ }),
    );

    expect(await screen.findByText("Câu hỏi thứ hai?")).toBeInTheDocument();
    expect(screen.getByText("Câu 2/2")).toBeInTheDocument();
    expect(getQuestion).toHaveBeenCalledTimes(2);
    expect(onComplete).not.toHaveBeenCalled();

    await user.click(screen.getByRole("button", { name: /Đúng/ }));
    await user.click(await screen.findByRole("button", { name: /Hoàn thành/ }));

    await waitFor(() => expect(onComplete).toHaveBeenCalledOnce());
    expect(getQuestion).toHaveBeenCalledTimes(2);
  });

  it("celebrates only a correct answer with fireworks and marks the choice", async () => {
    const user = userEvent.setup();
    setup([view(1, 2, "Câu hỏi thứ nhất?")]);

    await user.click(await screen.findByRole("button", { name: /Sai/ }));
    await screen.findByText("Gần đúng rồi, thử lại nhé.");
    expect(screen.queryByTestId("fireworks-burst")).not.toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: /Đúng/ }));
    await screen.findByText("Đúng rồi! Bé nhớ rất tốt.");

    const fireworks = screen.getByTestId("fireworks-burst");
    expect(fireworks).toHaveAttribute("aria-hidden", "true");
    expect(fireworks).toHaveClass("pointer-events-none");
    expect(screen.getByRole("button", { name: /Đúng/ })).toHaveClass(
      "bg-success-surface",
    );
    // Answers are locked after success, so the hover effect cannot apply.
    expect(screen.getByRole("button", { name: /Sai/ })).toBeDisabled();
  });

  it("emphasises answers on hover only while they can be chosen", async () => {
    setup([view(1, 1, "Câu hỏi?")]);
    const choice = await screen.findByRole("button", { name: /Đúng/ });
    expect(choice.className).toContain("enabled:hover:font-extrabold");
    expect(choice.className).toContain("enabled:hover:border-primary");
  });

  it("keeps single-question sources working", async () => {
    const user = userEvent.setup();
    const single = view(1, 1, "Chỉ một câu?");
    const { onComplete, getQuestion } = setup([
      {
        question: single.question,
        progress_label: "Câu 1",
        choices: single.choices,
      },
    ]);

    await user.click(await screen.findByRole("button", { name: /Đúng/ }));
    await user.click(
      await screen.findByRole("button", { name: /Câu tiếp theo/ }),
    );

    expect(onComplete).toHaveBeenCalledOnce();
    expect(getQuestion).toHaveBeenCalledTimes(1);
  });
});
