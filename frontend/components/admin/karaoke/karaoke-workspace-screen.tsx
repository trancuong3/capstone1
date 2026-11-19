"use client";
import { useEffect, useRef, useState } from "react";
import { AdminLoading } from "@/components/admin/admin-ui";
import { KaraokeEditorScreen } from "@/components/admin/karaoke/karaoke-editor-screen";
import { KaraokeWizardScreen } from "@/components/admin/karaoke/karaoke-wizard-screen";
import { Button, ButtonLink } from "@/components/common/button";
import { Card } from "@/components/common/card";
import { StatusMessage } from "@/components/common/status-message";
import { useAdminKaraoke } from "@/components/karaoke/karaoke-services-provider";
import { karaokeErrorMessage } from "@/lib/api/admin-karaoke-service";
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
}: {
  songId?: string;
  advanced?: boolean;
}) {
  return advanced ? (
    <KaraokeEditorScreen
      songId={songId}
      simpleHref={
        songId ? `/admin/karaoke/${songId}/edit` : "/admin/karaoke/new"
      }
    />
  ) : (
    <SimpleWorkspace key={songId ?? "new"} songId={songId} />
  );
}
function SimpleWorkspace({ songId }: { songId?: string }) {
  const service = useAdminKaraoke();
  const [loaded, setLoaded] = useState<Loaded | null>(null);
  const [error, setError] = useState("");
  const [reload, setReload] = useState(0);
  const [creating, setCreating] = useState(false);
  const mutation = useRef<AbortController | null>(null);
  useEffect(() => () => mutation.current?.abort(), []);
  useEffect(() => {
    const controller = new AbortController();
    Promise.all([
      songId ? service.get(songId, controller.signal) : Promise.resolve(null),
      service
        .getProcessingCapabilities(controller.signal)
        .catch((error: unknown) => {
          if (isServiceError(error) && error.status === 404) return null;
          throw error;
        }),
    ])
      .then(([detail, capabilities]) => {
        if (!controller.signal.aborted) setLoaded({ detail, capabilities });
      })
      .catch((error: unknown) => {
        if (!controller.signal.aborted) setError(karaokeErrorMessage(error));
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
    } catch (error) {
      if (!controller.signal.aborted) setError(karaokeErrorMessage(error));
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
