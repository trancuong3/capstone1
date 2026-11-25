"use client";
import { useEffect, useRef, useState } from "react";
import { AdminLoading } from "@/components/admin/admin-ui";
import { KaraokeEditorScreen } from "@/components/admin/karaoke/karaoke-editor-screen";
import { KaraokeSimpleUploadScreen } from "@/components/admin/karaoke/karaoke-simple-upload-screen";
import { KaraokeWizardScreen } from "@/components/admin/karaoke/karaoke-wizard-screen";
import { Button, ButtonLink } from "@/components/common/button";
import { Card } from "@/components/common/card";
import { StatusMessage } from "@/components/common/status-message";
import { useAdminKaraoke } from "@/components/karaoke/karaoke-services-provider";
import { karaokeErrorMessage } from "@/lib/api/admin-karaoke-service";
import type { KaraokeSimpleImportService } from "@/lib/api/karaoke-simple-import-service";
import { isServiceError } from "@/lib/api/service-error";
import type { AdminKaraokeDetail } from "@/types/karaoke";
import type { ProcessingCapabilities } from "@/types/karaoke-processing";

type Loaded = {
  detail: AdminKaraokeDetail | null;
  capabilities: ProcessingCapabilities | null;
};

export function KaraokeWorkspaceScreen({
  songId,
  advanced = false,
  simpleService,
}: {
  songId?: string;
  advanced?: boolean;
  simpleService?: KaraokeSimpleImportService;
}) {
  return (
    <KaraokeWorkspaceContent
      key={`${songId ?? "new"}:${advanced ? "advanced" : "default"}`}
      songId={songId}
      advanced={advanced}
      simpleService={simpleService}
    />
  );
}

function KaraokeWorkspaceContent({
  songId,
  advanced = false,
  simpleService,
}: {
  songId?: string;
  advanced?: boolean;
  simpleService?: KaraokeSimpleImportService;
}) {
  const [viewMode, setViewMode] = useState<"default" | "advanced">(
    advanced ? "advanced" : "default",
  );
  const [activeSongId, setActiveSongId] = useState<string | undefined>(songId);

  if (viewMode === "advanced") {
    return (
      <div className="grid gap-4">
        {!activeSongId ? (
          <div className="flex justify-end">
            <Button
              variant="quiet"
              size="compact"
              className="sm:w-auto"
              onClick={() => setViewMode("default")}
            >
              Quay lại Thêm nhanh 1 file MP3
            </Button>
          </div>
        ) : null}
        <KaraokeEditorScreen
          songId={activeSongId}
          simpleHref={
            activeSongId
              ? `/admin/karaoke/${activeSongId}/edit`
              : "/admin/karaoke/new"
          }
        />
      </div>
    );
  }

  return (
    <SimpleWorkspace
      key={activeSongId ?? "new"}
      songId={activeSongId}
      simpleService={simpleService}
      onSwitchAdvanced={(nextSongId) => {
        if (nextSongId) setActiveSongId(nextSongId);
        setViewMode("advanced");
      }}
    />
  );
}

function SimpleWorkspace({
  songId,
  simpleService,
  onSwitchAdvanced,
}: {
  songId?: string;
  simpleService?: KaraokeSimpleImportService;
  onSwitchAdvanced: (nextSongId?: string) => void;
}) {
  const service = useAdminKaraoke();
  const [loaded, setLoaded] = useState<Loaded | null>(null);
  const [error, setError] = useState("");
  const [reload, setReload] = useState(0);
  const [creating, setCreating] = useState(false);
  const [useLegacyWizard, setUseLegacyWizard] = useState(false);
  const mutation = useRef<AbortController | null>(null);

  useEffect(() => () => mutation.current?.abort(), []);
  useEffect(() => {
    const controller = new AbortController();
    Promise.all([
      songId ? service.get(songId, controller.signal) : Promise.resolve(null),
      service
        .getProcessingCapabilities(controller.signal)
        .catch((err: unknown) => {
          if (isServiceError(err) && err.status === 404) return null;
          throw err;
        }),
    ])
      .then(([detail, capabilities]) => {
        if (!controller.signal.aborted) setLoaded({ detail, capabilities });
      })
      .catch((err: unknown) => {
        if (!controller.signal.aborted) setError(karaokeErrorMessage(err));
      });
    return () => controller.abort();
  }, [service, songId, reload]);

  async function createDraft() {
    if (!loaded?.detail || mutation.current) return;
    const controller = new AbortController();
    mutation.current = controller;
    setCreating(true);
    setError("");
    try {
      const detail = await service.createDraft(
        loaded.detail.song_id,
        loaded.detail.revision,
        controller.signal,
      );
      if (!controller.signal.aborted) setLoaded({ ...loaded, detail });
    } catch (err) {
      if (!controller.signal.aborted) setError(karaokeErrorMessage(err));
    } finally {
      mutation.current = null;
      if (!controller.signal.aborted) setCreating(false);
    }
  }

  if (error)
    return (
      <StatusMessage tone="error">
        {error}
        <Button
          variant="quiet"
          className="mt-3 sm:w-auto"
          onClick={() => {
            setError("");
            setReload((n) => n + 1);
          }}
        >
          Thử tải lại
        </Button>
      </StatusMessage>
    );
  if (!loaded)
    return <AdminLoading label="Đang kiểm tra khả năng tạo karaoke…" />;
  if (loaded.detail && !loaded.detail.draft)
    return (
      <Card>
        <h1 className="text-2xl font-extrabold">Bài hát đã xuất bản</h1>
        <p>
          Bản xuất bản được giữ nguyên. Chỉ tạo bản nháp mới khi bạn muốn chỉnh
          sửa.
        </p>
        <Button
          disabled={creating}
          isLoading={creating}
          onClick={() => void createDraft()}
        >
          Tạo bản nháp để chỉnh sửa
        </Button>
        <ButtonLink href="/admin/karaoke" variant="quiet">
          Về danh sách
        </ButtonLink>
      </Card>
    );

  // Creating a new song defaults to 1-file Simple Mode whenever the current backend is reachable.
  // An old backend returning 404 on processing-capabilities (capabilities === null) preserves the manual fallback.
  if (!songId && loaded.capabilities !== null && !useLegacyWizard) {
    const wizardAvailable = Boolean(
      loaded.capabilities.enabled && loaded.capabilities.configured,
    );
    return (
      <KaraokeSimpleUploadScreen
        simpleService={simpleService}
        onSwitchAdvanced={onSwitchAdvanced}
        onSwitchWizard={
          wizardAvailable ? () => setUseLegacyWizard(true) : undefined
        }
      />
    );
  }

  if (
    (!loaded.capabilities?.enabled || !loaded.capabilities.configured) &&
    !loaded.detail?.processing_review?.required &&
    !loaded.detail?.processing_summary
  )
    return (
      <div className="grid gap-5">
        <StatusMessage tone="info">
          Tự động tạo karaoke chưa sẵn sàng trên máy chủ này. Bạn vẫn có thể tải
          nhạc và căn lời bằng trình chỉnh sửa hiện có.
        </StatusMessage>
        <KaraokeEditorScreen songId={songId} />
      </div>
    );
  return (
    <KaraokeWizardScreen
      initial={loaded.detail}
      capabilities={loaded.capabilities}
    />
  );
}
