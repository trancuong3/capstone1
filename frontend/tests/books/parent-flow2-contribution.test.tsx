import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import { AdminFlow2CandidatesPanel } from "@/components/admin/admin-flow2-candidates-panel";
import { ParentOcrContributionCard } from "@/components/books/parent-ocr-contribution-card";
import type { AdminBookContentQualityService } from "@/lib/api/admin-book-content-quality-service";
import type {
  AdminFlow2CandidatePageDTO,
  ParentOcrContributionStateDTO,
} from "@/types/parent-private-book";

const mockAdminServices = vi.hoisted(() => ({
  bookContentQuality: {} as AdminBookContentQualityService,
}));

vi.mock("@/hooks/use-admin-services", () => ({
  useAdminServices: () => mockAdminServices,
}));

vi.mock("@/components/common/authenticated-image", () => ({
  AuthenticatedImage: ({ alt, src }: { alt: string; src: string }) => (
    <img alt={alt} data-testid="auth-crop-image" src={src} />
  ),
}));

const BASE_STATE_OFF: ParentOcrContributionStateDTO = {
  book_id: "11111111-1111-4111-8111-111111111111",
  enabled: false,
  status: "OPTED_OUT",
  purpose: "FLOW2_ADMIN_VERIFIED_OCR",
  consent_version: 0,
  notice_version: "v1-2026-11-22",
  rights_confirmed: false,
  consented_at: null,
  revoked_at: null,
  revoke_reason: null,
  rights_basis: "SELF_AUTHORED",
  rights_eligible_for_training: true,
  rights_ineligible_reason: null,
  pending_verification_count: 0,
  sync_queued_count: 0,
  synced_count: 0,
  rejected_count: 0,
  revoked_count: 0,
  status_notice: "Sách này hiện không được dùng để huấn luyện OCR.",
};

describe("Parent Private Book -> Flow 2 OCR Contribution UI", () => {
  it("requires explicit rights confirmation before enabling and supports opting out", async () => {
    const onUpdate = vi.fn().mockResolvedValue(undefined);
    const { rerender } = render(
      <ParentOcrContributionCard
        bookTitle="Truyện nhà A"
        onUpdate={onUpdate}
        state={BASE_STATE_OFF}
      />,
    );

    expect(
      screen.getByText(/Đang tắt — không dùng để huấn luyện/i),
    ).toBeInTheDocument();
    const enableBtn = screen.getByRole("button", {
      name: /Bật đóng góp mẫu OCR/i,
    });
    expect(enableBtn).toBeDisabled();

    fireEvent.click(screen.getByRole("checkbox"));
    expect(enableBtn).toBeEnabled();
    fireEvent.click(enableBtn);

    await waitFor(() => {
      expect(onUpdate).toHaveBeenCalledWith({
        enabled: true,
        rights_confirmed: true,
        notice_version: "v1-2026-11-22",
      });
    });

    rerender(
      <ParentOcrContributionCard
        bookTitle="Truyện nhà A"
        onUpdate={onUpdate}
        state={{
          ...BASE_STATE_OFF,
          enabled: true,
          status: "OPTED_IN",
          consent_version: 1,
          rights_confirmed: true,
          consented_at: "2026-11-22T04:00:00Z",
          pending_verification_count: 2,
          synced_count: 1,
        }}
      />,
    );

    expect(screen.getByText(/Chờ Admin xác minh: 2/i)).toBeInTheDocument();
    expect(screen.getByText(/Đã đồng bộ Flow 2: 1/i)).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: /Ngừng đóng góp/i }));
    await waitFor(() => {
      expect(onUpdate).toHaveBeenLastCalledWith(
        expect.objectContaining({
          enabled: false,
          rights_confirmed: false,
          revoke_reason: "PARENT_OPTED_OUT",
        }),
      );
    });
  });

  it("lets Admin compare cropped line image with NFC label and approve without exposing parent email or child profile", async () => {
    const mockPage: AdminFlow2CandidatePageDTO = {
      items: [
        {
          id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
          book_id: "11111111-1111-4111-8111-111111111111",
          book_title: "Truyện tự sáng tác nhà A",
          page_id: "22222222-2222-4222-8222-222222222222",
          page_number: 1,
          revision_id: "33333333-3333-4333-8333-333333333333",
          line_index: 0,
          consent_version: 1,
          crop_image_url:
            "/books/admin/quality/user-books/flow2-candidates/aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa/crop",
          image_sha256: "a".repeat(64),
          proposed_label: "Mốt con vịt xòe ra hai cái cánh.",
          verified_label: null,
          rights_basis: "SELF_AUTHORED",
          rights_basis_label: "Tự biên soạn / gia đình tự viết",
          pii_check_status: "CLEAR",
          pii_flags: [],
          quality_metrics: { width: 420, height: 60 },
          status: "PENDING_VERIFICATION",
          status_label: "Chờ xác minh mẫu",
          verified_at: null,
          rejection_code: null,
          rejection_reason: null,
          outbox_event_id: null,
          sample_id: null,
          revoked_at: null,
          revoke_reason: null,
          created_at: "2026-11-22T04:00:00Z",
          updated_at: "2026-11-22T04:00:00Z",
        },
      ],
      total: 1,
      limit: 50,
      offset: 0,
      summary: { PENDING_VERIFICATION: 1 },
    };

    const decideFlow2Candidate = vi.fn().mockResolvedValue({
      candidate_id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
      book_id: "11111111-1111-4111-8111-111111111111",
      page_id: "22222222-2222-4222-8222-222222222222",
      revision_id: "33333333-3333-4333-8333-333333333333",
      decision: "APPROVE",
      status: "SYNC_QUEUED",
      verified_label: "Một con vịt xòe ra hai cái cánh.",
      outbox_event_id: "44444444-4444-4444-8444-444444444444",
      rejection_code: null,
      rejection_reason: null,
      decided_at: "2026-11-22T04:05:00Z",
      audit_log_id: "55555555-5555-4555-8555-555555555555",
    });

    mockAdminServices.bookContentQuality = {
      listFlow2Candidates: vi.fn().mockResolvedValue(mockPage),
      decideFlow2Candidate,
    } as unknown as AdminBookContentQualityService;

    render(<AdminFlow2CandidatesPanel />);

    const input = await screen.findByLabelText(/Nhãn dòng chữ chính xác/i);
    expect(screen.getByTestId("auth-crop-image")).toHaveAttribute(
      "src",
      expect.stringContaining("/flow2-candidates/"),
    );

    // Fix AI diacritic mistake ("Mốt" -> "Một") to match actual printed text on crop
    fireEvent.change(input, {
      target: { value: "Một con vịt xòe ra hai cái cánh." },
    });
    fireEvent.click(screen.getByRole("button", { name: /Xác nhận nhãn/i }));

    await waitFor(() => {
      expect(decideFlow2Candidate).toHaveBeenCalledWith(
        "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
        {
          decision: "APPROVE",
          verified_label: "Một con vịt xòe ra hai cái cánh.",
        },
      );
    });
  });
});
