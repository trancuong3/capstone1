import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useState } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { ChildProfileForm } from "@/components/children/child-profile-form";
import type { ChildProfileCreateDTO } from "@/types/child";

const originalCreateObjectURL = URL.createObjectURL;
const originalRevokeObjectURL = URL.revokeObjectURL;

beforeEach(() => {
  Object.defineProperty(URL, "createObjectURL", {
    configurable: true,
    value: vi.fn(() => "blob:child-preview"),
  });
  Object.defineProperty(URL, "revokeObjectURL", {
    configurable: true,
    value: vi.fn(),
  });
});

afterEach(() => {
  if (originalCreateObjectURL) {
    Object.defineProperty(URL, "createObjectURL", {
      configurable: true,
      value: originalCreateObjectURL,
    });
  } else {
    Reflect.deleteProperty(URL, "createObjectURL");
  }
  if (originalRevokeObjectURL) {
    Object.defineProperty(URL, "revokeObjectURL", {
      configurable: true,
      value: originalRevokeObjectURL,
    });
  } else {
    Reflect.deleteProperty(URL, "revokeObjectURL");
  }
});

function ControlledChildProfileForm({ mode }: { mode: "create" | "edit" }) {
  const [selectedFile, setSelectedFile] = useState<File | null>(null);
  const [isRemoved, setIsRemoved] = useState(false);

  return (
    <ChildProfileForm
      avatarUrl={mode === "edit" ? "https://storage.example/child.webp" : null}
      defaultValues={{ alias: "Bé An", grade: 2 }}
      isAvatarRemoved={isRemoved}
      mode={mode}
      onAvatarFileChange={(file) => {
        setSelectedFile(file);
        setIsRemoved(false);
      }}
      onAvatarRemove={() => {
        setSelectedFile(null);
        setIsRemoved((removed) => !removed);
      }}
      onSubmit={async () => undefined}
      selectedAvatarFile={selectedFile}
    />
  );
}

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

  it.each(["create", "edit"] as const)(
    "previews an accepted avatar in %s mode and can remove the pending selection",
    async (mode) => {
      const user = userEvent.setup();
      render(<ControlledChildProfileForm mode={mode} />);
      const file = new File(["avatar"], "child.webp", { type: "image/webp" });

      await user.upload(
        screen.getByLabelText("Chọn ảnh đại diện PNG, JPG hoặc WEBP"),
        file,
      );

      const avatar = await screen.findByRole("img", {
        name: "Ảnh xem trước của Bé An",
      });
      expect(avatar.querySelector("img")).toHaveAttribute(
        "src",
        "blob:child-preview",
      );
      expect(URL.createObjectURL).toHaveBeenCalledWith(file);

      await user.click(screen.getByRole("button", { name: "Xóa ảnh" }));
      expect(
        screen.getByText("Ảnh sẽ được xóa khi ba mẹ lưu thay đổi."),
      ).toBeInTheDocument();
    },
  );

  it("rejects files whose MIME type is not an allowed image", async () => {
    const user = userEvent.setup({ applyAccept: false });
    render(<ControlledChildProfileForm mode="create" />);
    await user.upload(
      screen.getByLabelText("Chọn ảnh đại diện PNG, JPG hoặc WEBP"),
      new File(["not an image"], "payload.svg", { type: "image/svg+xml" }),
    );

    expect(
      await screen.findByText("Chỉ hỗ trợ ảnh PNG, JPG hoặc WEBP."),
    ).toBeInTheDocument();
    expect(URL.createObjectURL).not.toHaveBeenCalled();
  });
});
