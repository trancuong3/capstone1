import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { AdminVireadTrainingScreen } from "@/components/admin/admin-viread-training-screen";
import {
  AdminServicesContext,
  type AdminServices,
} from "@/components/providers/admin-services-provider";
import type {
  GoogleDriveTrainingStatus,
  VireadTrainingOverview,
  VireadTrainingService,
} from "@/lib/api/viread-training-service";

const connectedDriveStatus: GoogleDriveTrainingStatus = {
  provider: "google_drive",
  migration_applied: true,
  status: "CONNECTED",
  connected: true,
  oauth_configured: true,
  account_email: "admin-drive@example.com",
  account_display_name: "ViRead Admin",
  oauth_scope: "https://www.googleapis.com/auth/drive.file",
  scope_valid: true,
  root_folder_id: "drv_root_000001_viread",
  root_folder_path: "MyDrive/ViRead/OCR-Training/Flow2-Admin-Verified",
  subfolder_ids: { "verified-samples": "drv_sub_001" },
  quota: {
    limit_bytes: 15 * 1024 * 1024 * 1024,
    usage_bytes: 3 * 1024 * 1024 * 1024,
    usage_in_drive_bytes: 3 * 1024 * 1024 * 1024,
    usage_in_trash_bytes: 0,
    available_bytes: 12 * 1024 * 1024 * 1024,
    min_free_buffer_bytes: 512 * 1024 * 1024,
    max_training_budget_bytes: null,
    warning_level: "OK",
    can_accept_upload: true,
    checked_at: "2026-11-21T12:00:00+00:00",
  },
  last_health_check_at: "2026-11-21T12:00:00+00:00",
  last_health_status: "HEALTHY",
  last_error_code: null,
  connected_at: "2026-11-21T10:00:00+00:00",
  disconnected_at: null,
};

function makeOverview(
  overrides: Partial<VireadTrainingOverview> = {},
): VireadTrainingOverview {
  return {
    outbox: [
      { status: "PENDING", count: 2 },
      { status: "BLOCKED", count: 1 },
      { status: "SKIPPED", count: 3 },
      { status: "DONE", count: 12 },
    ],
    samples: [
      { source_flow: "FLOW1_VERIFIED", split: "train", count: 40 },
      { source_flow: "FLOW1_VERIFIED", split: "validation", count: 12 },
      { source_flow: "FLOW1_VERIFIED", split: "holdout", count: 15 },
    ],
    jobs: [],
    runs: [
      {
        run_id: "11111111-1111-4111-8111-111111111111",
        profile: "FLOW2_ADMIN_VERIFIED",
        status: "BENCHMARKED",
        parent_checkpoint_sha256: "a".repeat(64),
        manifest_sha256: "b".repeat(64),
        checkpoint_sha256: "c".repeat(64),
        checkpoint_storage_path: "gdrive://drv_ckpt_00001_viread",
        step: 5000,
        created_at: "2026-11-21T11:00:00+00:00",
      },
    ],
    benchmarks: [
      {
        benchmark_id: "22222222-2222-4222-8222-222222222222",
        run_id: "11111111-1111-4111-8111-111111111111",
        gate_status: "V2_WIN",
        sample_count: 30,
        group_count: 6,
        candidate_checkpoint_sha256: "c".repeat(64),
        locked_test_manifest_sha256: "d".repeat(64),
        created_at: "2026-11-21T11:30:00+00:00",
        evaluation_type: "PILOT",
      },
    ],
    active_model: {
      model_family: "vgg_transformer",
      checkpoint_sha256: "a".repeat(64),
      storage_path: "gdrive://drv_active_0001_viread",
      storage_provider: "google_drive",
      drive_file_id: "drv_active_0001_viread",
      profile: "FLOW2_ADMIN_VERIFIED",
      decision_id: "33333333-3333-4333-8333-333333333333",
      updated_at: "2026-11-21T09:00:00+00:00",
    },
    locked_test: {
      status: "NEEDS_DATA",
      version_id: null,
      manifest_sha256: null,
      sample_count: 0,
      group_count: 0,
      eligible_sample_count: 15,
      eligible_group_count: 4,
      missing_sample_count: 185,
      missing_group_count: 26,
      minimum_samples: 200,
      minimum_groups: 30,
    },
    google_drive: connectedDriveStatus,
    runtime_model: {
      initialized: true,
      initialization_status: "loaded",
      initialization_error: null,
      loaded_profile: "ORIGINAL",
      loaded_checkpoint_sha256: "3".repeat(64),
      loaded_config_sha256: null,
      verified_runtime_proof: true,
      desired_profile: "FLOW2_ADMIN_VERIFIED",
      desired_checkpoint_sha256: "a".repeat(64),
      matches_desired: false,
      status_label: "FALLBACK_TO_ORIGINAL",
    },
    storage_summary: {
      flow2_write_provider: "google_drive",
      flow2_drive_synced_samples: 62,
      flow2_legacy_samples: 5,
      flow2_verified_total_samples: 67,
      flow2_train_samples: 40,
      flow2_validation_samples: 12,
      flow2_holdout_samples: 15,
      dataset_ready_for_training: true,
      outbox_pending: 2,
      outbox_retry: 0,
      outbox_dead: 0,
      outbox_blocked: 1,
      outbox_skipped: 3,
      outbox_done: 12,
    },
    ...overrides,
  };
}

describe("AdminVireadTrainingScreen - Flow 2 Google Drive & Safety Controls", () => {
  let mockService: Partial<VireadTrainingService>;

  beforeEach(() => {
    mockService = {
      overview: vi.fn().mockResolvedValue(makeOverview()),
      checkDriveHealth: vi.fn().mockResolvedValue({
        ...connectedDriveStatus,
        health_detail: "Google Drive connected and Flow 2 folder tree verified",
      }),
      runDriveSelfTest: vi.fn().mockResolvedValue({
        ok: true,
        logical_path: "_selftest/selftest-123.txt",
        drive_file_id: "drv_selftest_001",
        sha256: "f".repeat(64),
        size_bytes: 58,
        deleted_after_test: true,
        is_private: true,
        quota: connectedDriveStatus.quota,
        detail: "Self-test OK",
      }),
      disconnectDrive: vi.fn().mockResolvedValue({
        ...connectedDriveStatus,
        status: "DISCONNECTED",
        connected: false,
      }),
      startDriveConnect: vi.fn(),
      completeDriveCallback: vi.fn(),
      connectDriveAppsScript: vi.fn().mockResolvedValue({
        ...connectedDriveStatus,
        connection_mode: "apps_script_bridge",
        oauth_scope: "apps_script_bridge",
        account_email: "cuongtran290605@gmail.com",
      }),
      connectDriveDesktop: vi.fn().mockResolvedValue({
        ...connectedDriveStatus,
        connection_mode: "drive_desktop_sync",
        oauth_scope: "drive_desktop_sync",
        account_email: "cuongtran290605@gmail.com",
      }),
      decide: vi.fn(),
      retry: vi.fn(),
      deleteJob: vi.fn(),
      requestEvaluation: vi.fn(),
      discardMismatchedCandidate: vi.fn(),
      closeUnbenchmarkedCandidate: vi.fn(),
    };
  });

  function renderScreen() {
    return render(
      <AdminServicesContext.Provider
        value={
          {
            vireadTraining: mockService as VireadTrainingService,
          } as unknown as AdminServices
        }
      >
        <AdminVireadTrainingScreen />
      </AdminServicesContext.Provider>,
    );
  }

  it("renders Google Drive status, quota, Desired vs Loaded mismatch warning, and blocks Pilot approval", async () => {
    renderScreen();
    const user = userEvent.setup();

    // Overview & Runtime tab is selected by default
    await waitFor(() => {
      expect(screen.getByText(/FALLBACK_TO_ORIGINAL/)).toBeInTheDocument();
    });
    expect(screen.getByText(/Cảnh báo lệch model/i)).toBeInTheDocument();

    // Outbox error/blocked and AI-only skipped breakdown shown
    expect(screen.getByText(/1 lỗi\/chặn/i)).toBeInTheDocument();
    expect(
      screen.getByText(/3 sự kiện AI-only đã bỏ qua an toàn/i),
    ).toBeInTheDocument();

    // Switch to Google Drive tab
    await user.click(screen.getByRole("tab", { name: /Google Drive/i }));
    await waitFor(() => {
      expect(
        screen.getByText(/Lưu trữ Luồng 2 · Google Drive \(0 VNĐ\)/i),
      ).toBeInTheDocument();
    });

    // Drive connection + least-privilege scope + dedicated path + quota
    expect(screen.getByText("admin-drive@example.com")).toBeInTheDocument();
    expect(screen.getByText(/drive\.file \(tối thiểu\)/i)).toBeInTheDocument();
    expect(
      screen.getByText("MyDrive/ViRead/OCR-Training/Flow2-Admin-Verified"),
    ).toBeInTheDocument();
    expect(screen.getByText(/Còn trống: 12\.00 GiB/i)).toBeInTheDocument();

    // Switch to Flow 2 tab and verify PILOT benchmark never exposes Production Approve
    await user.click(
      screen.getByRole("tab", { name: /Huấn luyện & Đánh giá Flow 2/i }),
    );
    expect(
      screen.queryByRole("button", { name: /Phê duyệt model/i }),
    ).not.toBeInTheDocument();
  });

  it("runs Drive health-check, self-test, and modal-confirmed disconnect from the Admin UI", async () => {
    renderScreen();
    const user = userEvent.setup();

    await waitFor(() => {
      expect(
        screen.getByRole("tab", { name: /Google Drive/i }),
      ).toBeInTheDocument();
    });
    await user.click(screen.getByRole("tab", { name: /Google Drive/i }));

    await waitFor(() => {
      expect(
        screen.getByRole("button", { name: /Kiểm thử Upload \/ Đọc \/ Xóa/i }),
      ).toBeInTheDocument();
    });

    await user.click(
      screen.getByRole("button", { name: /Kiểm tra kết nối & dung lượng/i }),
    );
    await waitFor(() => {
      expect(mockService.checkDriveHealth).toHaveBeenCalledTimes(1);
    });

    await user.click(
      screen.getByRole("button", { name: /Kiểm thử Upload \/ Đọc \/ Xóa/i }),
    );
    await waitFor(() => {
      expect(mockService.runDriveSelfTest).toHaveBeenCalledTimes(1);
      expect(
        screen.getByText(/_selftest\/selftest-123\.txt/),
      ).toBeInTheDocument();
    });

    // Disconnect uses an accessible alertdialog modal (no globalThis.confirm)
    await user.click(
      screen.getByRole("button", { name: /Ngắt kết nối an toàn/i }),
    );
    const dialog = screen.getByRole("alertdialog");
    await user.click(within(dialog).getByRole("button", { name: "Hủy" }));
    expect(mockService.disconnectDrive).not.toHaveBeenCalled();

    await user.click(
      screen.getByRole("button", { name: /Ngắt kết nối an toàn/i }),
    );
    await user.click(
      within(screen.getByRole("alertdialog")).getByRole("button", {
        name: "Ngắt kết nối",
      }),
    );
    await waitFor(() => {
      expect(mockService.disconnectDrive).toHaveBeenCalledTimes(1);
    });
  });

  it("shows clear recovery guidance when Drive token is revoked and disables unsafe actions", async () => {
    mockService.overview = vi.fn().mockResolvedValue(
      makeOverview({
        google_drive: {
          ...connectedDriveStatus,
          status: "TOKEN_REVOKED",
          connected: false,
          last_error_code: "DRIVE_TOKEN_REVOKED",
          quota: {
            ...connectedDriveStatus.quota,
            can_accept_upload: false,
            warning_level: "EXCEEDED",
          },
        },
      }),
    );

    renderScreen();
    const user = userEvent.setup();

    await waitFor(() => {
      expect(
        screen.getByRole("tab", { name: /Google Drive/i }),
      ).toBeInTheDocument();
    });
    await user.click(screen.getByRole("tab", { name: /Google Drive/i }));

    await waitFor(() => {
      expect(screen.getByText(/Token bị thu hồi/i)).toBeInTheDocument();
    });
    expect(
      screen.getByText(/Google đã thu hồi refresh token/i),
    ).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: /Kiểm thử Upload \/ Đọc \/ Xóa/i }),
    ).toBeDisabled();
  });

  it("keeps Production V2_WIN Approve button visible even when a newer Pilot benchmark exists", async () => {
    const base = makeOverview();
    mockService.overview = vi.fn().mockResolvedValue({
      ...base,
      benchmarks: [
        // Newer PILOT benchmark listed first (created_at DESC)
        {
          benchmark_id: "55555555-5555-4555-8555-555555555555",
          run_id: "11111111-1111-4111-8111-111111111111",
          gate_status: "INSUFFICIENT_EVIDENCE",
          sample_count: 30,
          group_count: 6,
          candidate_checkpoint_sha256: "c".repeat(64),
          locked_test_manifest_sha256: "e".repeat(64),
          created_at: "2026-11-21T12:30:00+00:00",
          evaluation_type: "PILOT",
        },
        // Passing PRODUCTION benchmark
        {
          benchmark_id: "66666666-6666-4666-8666-666666666666",
          run_id: "11111111-1111-4111-8111-111111111111",
          gate_status: "V2_WIN",
          sample_count: 220,
          group_count: 35,
          candidate_checkpoint_sha256: "c".repeat(64),
          locked_test_manifest_sha256: "d".repeat(64),
          created_at: "2026-11-21T11:30:00+00:00",
          evaluation_type: "PRODUCTION",
        },
      ],
    });

    renderScreen();
    const user = userEvent.setup();

    await waitFor(() => {
      expect(
        screen.getByRole("tab", { name: /Huấn luyện & Đánh giá Flow 2/i }),
      ).toBeInTheDocument();
    });
    await user.click(
      screen.getByRole("tab", { name: /Huấn luyện & Đánh giá Flow 2/i }),
    );

    await waitFor(() => {
      expect(
        screen.getByRole("button", { name: /Phê duyệt model/i }),
      ).not.toBeDisabled();
    });
  });

  it("connects via zero-card Apps Script Bridge from the Admin UI", async () => {
    mockService.overview = vi.fn().mockResolvedValue(
      makeOverview({
        google_drive: {
          ...connectedDriveStatus,
          status: "DISCONNECTED",
          connected: false,
          connection_mode: null,
          oauth_configured: false,
          apps_script_readiness: {
            bridge_ready: true,
            encryption_key_configured: true,
            server_secret_configured: true,
            web_app_url_configured: false,
            required_account_email: "cuongtran290605@gmail.com",
          },
          required_account_email: "cuongtran290605@gmail.com",
          account_email: null,
          oauth_scope: null,
          scope_valid: false,
        },
      }),
    );

    renderScreen();
    const user = userEvent.setup();

    await waitFor(() => {
      expect(
        screen.getByRole("tab", { name: /Google Drive/i }),
      ).toBeInTheDocument();
    });
    await user.click(screen.getByRole("tab", { name: /Google Drive/i }));

    await waitFor(() => {
      expect(
        screen.getByRole("button", {
          name: /Kết nối không cần thẻ \(Apps Script\)/i,
        }),
      ).toBeInTheDocument();
    });

    await user.click(
      screen.getByRole("button", {
        name: /Kết nối không cần thẻ \(Apps Script\)/i,
      }),
    );

    const urlInput = screen.getByPlaceholderText(
      /https:\/\/script\.google\.com\/macros\/s\/\.\.\.\/exec/i,
    );
    await user.type(
      urlInput,
      "https://script.google.com/macros/s/AKfycbzViReadBridgeTestDeployment0123456789/exec",
    );
    await user.click(
      screen.getByRole("button", { name: /Xác minh & Lưu kết nối Bridge/i }),
    );

    await waitFor(() => {
      expect(mockService.connectDriveAppsScript).toHaveBeenCalledWith({
        web_app_url:
          "https://script.google.com/macros/s/AKfycbzViReadBridgeTestDeployment0123456789/exec",
      });
    });
  });

  it("connects via official Google Drive for Desktop mount from the Admin UI", async () => {
    mockService.overview = vi.fn().mockResolvedValue(
      makeOverview({
        google_drive: {
          ...connectedDriveStatus,
          status: "DISCONNECTED",
          connected: false,
          connection_mode: null,
          oauth_configured: false,
          drive_desktop_readiness: {
            desktop_ready: true,
            encryption_key_configured: true,
            detected_mounts: [
              {
                drive_root: "G:\\My Drive",
                flow2_root:
                  "G:\\My Drive\\ViRead\\OCR-Training\\Flow2-Admin-Verified",
                account_email: "cuongtran290605@gmail.com",
              },
            ],
            default_mount_path: "G:\\My Drive",
            required_account_email: "cuongtran290605@gmail.com",
          },
          required_account_email: "cuongtran290605@gmail.com",
          account_email: null,
          oauth_scope: null,
          scope_valid: false,
        },
      }),
    );

    renderScreen();
    const user = userEvent.setup();

    await waitFor(() => {
      expect(
        screen.getByRole("tab", { name: /Google Drive/i }),
      ).toBeInTheDocument();
    });
    await user.click(screen.getByRole("tab", { name: /Google Drive/i }));

    await waitFor(() => {
      expect(
        screen.getByRole("button", {
          name: /Kết nối Google Drive for Desktop \(0 thẻ\)/i,
        }),
      ).toBeInTheDocument();
    });

    await user.click(
      screen.getByRole("button", {
        name: /Kết nối Google Drive for Desktop \(0 thẻ\)/i,
      }),
    );
    await user.click(
      screen.getByRole("button", {
        name: /Xác minh & Lưu kết nối Drive Desktop/i,
      }),
    );

    await waitFor(() => {
      expect(mockService.connectDriveDesktop).toHaveBeenCalledWith({
        sync_root_path: "G:\\My Drive",
      });
    });
  });

  it("triggers Flow 2 training snapshot/job, renders blockers, and enables Production eval on READY_TO_CREATE", async () => {
    const base = makeOverview();
    mockService.triggerFlow2 = vi.fn().mockResolvedValue({
      scheduled: 1,
      reason: "JOB_ENQUEUED",
      job_id: "77777777-7777-4777-8777-777777777777",
      status: "WAITING_FOR_COLAB_WORKER",
      target: "COLAB",
      train_count: 141,
      validation_count: 83,
      locked_test_ready: false,
    });
    mockService.overview = vi.fn().mockResolvedValue({
      ...base,
      worker_status: {
        local_training_enabled: false,
        local_gpu_ready: false,
        web_heavy_workers_disabled: true,
        execution_mode: "COLAB",
      },
      flow2_blockers: ["Worker nền Web bị tắt (dùng nút kích hoạt bên dưới)."],
      locked_test: {
        ...base.locked_test!,
        status: "READY_TO_CREATE",
        eligible_sample_count: 210,
        eligible_group_count: 31,
      },
      jobs: [
        {
          job_id: "88888888-8888-4888-8888-888888888888",
          profile: "FLOW2_ADMIN_VERIFIED",
          target: "COLAB",
          status: "CANDIDATE",
          dataset_version_id: "99999999-9999-4999-8999-999999999999",
          manifest_sha256: "b".repeat(64),
          config_sha256: "c".repeat(64),
          parent_checkpoint_sha256: "a".repeat(64),
          run_id: "11111111-1111-4111-8111-111111111111",
          run_status: "CANDIDATE",
          run_config_sha256: "c".repeat(64),
          candidate_has_benchmark: false,
          attempts: 1,
          progress: {},
          last_error_code: null,
          metadata: {},
          created_at: "2026-11-21T10:00:00+00:00",
          updated_at: "2026-11-21T10:00:00+00:00",
        },
      ],
    });

    renderScreen();
    const user = userEvent.setup();

    await waitFor(() => {
      expect(
        screen.getByRole("tab", { name: /Huấn luyện & Đánh giá Flow 2/i }),
      ).toBeInTheDocument();
    });
    await user.click(
      screen.getByRole("tab", { name: /Huấn luyện & Đánh giá Flow 2/i }),
    );

    await waitFor(() => {
      expect(
        screen.getByText(
          /Worker nền Web bị tắt \(dùng nút kích hoạt bên dưới\)/i,
        ),
      ).toBeInTheDocument();
    });

    // Production Locked Test button is enabled for READY_TO_CREATE
    expect(
      screen.getByRole("button", { name: /Chạy Production Locked Test/i }),
    ).not.toBeDisabled();

    await user.click(
      screen.getByRole("button", {
        name: /Tạo snapshot & Xếp hàng train Luồng 2/i,
      }),
    );
    await waitFor(() => {
      expect(mockService.triggerFlow2).toHaveBeenCalledTimes(1);
      expect(
        screen.getByText(/141 train \/ 83 validation/i),
      ).toBeInTheDocument();
    });
  });

  it("shows trash fallback warning when GAS health check reports advanced_drive_enabled=false", async () => {
    mockService.checkDriveHealth = vi.fn().mockResolvedValue({
      ...connectedDriveStatus,
      connection_mode: "apps_script_bridge",
      oauth_scope: "apps_script_bridge",
      advanced_drive_enabled: false,
      delete_mode: "trash_fallback",
      warnings: [
        "Apps Script Advanced Drive Service (Drive API) chưa được bật.",
      ],
    });

    renderScreen();
    const user = userEvent.setup();

    await waitFor(() => {
      expect(
        screen.getByRole("tab", { name: /Google Drive/i }),
      ).toBeInTheDocument();
    });
    await user.click(screen.getByRole("tab", { name: /Google Drive/i }));

    await waitFor(() => {
      expect(
        screen.getByRole("button", { name: /Kiểm tra kết nối/i }),
      ).toBeInTheDocument();
    });
    await user.click(
      screen.getByRole("button", { name: /Kiểm tra kết nối/i }),
    );

    await waitFor(() => {
      expect(
        screen.getByText(/Cảnh báo xóa tạm thời \(Google Drive Trash Fallback\)/i),
      ).toBeInTheDocument();
    });
  });
});
