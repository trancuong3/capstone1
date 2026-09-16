import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";

import { ChildProfileForm } from "@/components/children/child-profile-form";
import type { ChildProfileCreateDTO } from "@/types/child";

describe("ChildProfileForm", () => {
  it("validates the required alias at field level", async () => {
    const user = userEvent.setup();
    const onSubmit = vi.fn(async (values: ChildProfileCreateDTO) => {
      void values;
    });
    render(<ChildProfileForm mode="create" onSubmit={onSubmit} />);

    await user.click(screen.getByRole("button", { name: "Lưu hồ sơ" }));

    expect(
      await screen.findByText("Ba mẹ vui lòng nhập tên gọi của bé."),
    ).toBeInTheDocument();
    expect(screen.getByLabelText("Tên gọi của bé")).toHaveAttribute(
      "aria-invalid",
      "true",
    );
    expect(onSubmit).not.toHaveBeenCalled();
  });

  it("submits only alias and grade from the canonical create DTO", async () => {
    const user = userEvent.setup();
    const onSubmit = vi.fn(async (values: ChildProfileCreateDTO) => {
      void values;
    });
    render(<ChildProfileForm mode="create" onSubmit={onSubmit} />);

    await user.type(screen.getByLabelText("Tên gọi của bé"), "  Bé Na  ");
    await user.selectOptions(screen.getByLabelText("Lớp của bé"), "3");
    await user.click(screen.getByRole("button", { name: "Lưu hồ sơ" }));

    await waitFor(() => {
      expect(onSubmit).toHaveBeenCalledWith({ alias: "Bé Na", grade: 3 });
    });
    expect(onSubmit.mock.calls[0]?.[0]).not.toHaveProperty("parent_id");
  });

  it("disables repeated submission while saving", async () => {
    const user = userEvent.setup();
    const onSubmit = vi.fn((values: ChildProfileCreateDTO) => {
      void values;
      return new Promise<void>(() => undefined);
    });
    render(<ChildProfileForm mode="create" onSubmit={onSubmit} />);

    await user.type(screen.getByLabelText("Tên gọi của bé"), "Bé Na");
    await user.click(screen.getByRole("button", { name: "Lưu hồ sơ" }));

    expect(screen.getByRole("button", { name: "Đang lưu…" })).toBeDisabled();
    expect(onSubmit).toHaveBeenCalledTimes(1);
  });

  it("uses the supplied values in edit mode", () => {
    render(
      <ChildProfileForm
        defaultValues={{ alias: "Bé An", grade: 2 }}
        mode="edit"
        onSubmit={async () => undefined}
      />,
    );

    expect(screen.getByLabelText("Tên gọi của bé")).toHaveValue("Bé An");
    expect(screen.getByLabelText("Lớp của bé")).toHaveValue("2");
  });
});
