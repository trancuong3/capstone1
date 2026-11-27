"use client";

import { Image as ImageIcon, Music2, UploadCloud } from "lucide-react";
import { useRef, useState } from "react";
import { AdminBadge } from "@/components/admin/admin-ui";
import {
  KaraokeConfirmModal,
  type KaraokeConfirmRequest,
} from "@/components/admin/karaoke/karaoke-confirm-modal";
import { StatusMessage } from "@/components/common/status-message";
import { Button } from "@/components/common/button";
import { useI18n, useTranslations } from "@/hooks/use-i18n";
import type { AdminKaraokeDetail } from "@/types/karaoke";

export function SongMediaUpload({
  draft,
  disabled,
  onUpload,
}: {
  draft: NonNullable<AdminKaraokeDetail["draft"]>;
  disabled: boolean;
  onUpload: (kind: "audio" | "cover", file: File) => void;
}) {
  const t = useTranslations("admin");
  const { formatNumber } = useI18n();
  const [error, setError] = useState("");
  const [confirmRequest, setConfirmRequest] =
    useState<KaraokeConfirmRequest | null>(null);
  const audio = useRef<HTMLInputElement>(null);
  const cover = useRef<HTMLInputElement>(null);

  function choose(kind: "audio" | "cover", file?: File) {
    setError("");
    if (!file || disabled) return;
    const valid =
      kind === "audio"
        ? /\.mp3$/i.test(file.name)
        : /\.(jpe?g|png|webp)$/i.test(file.name);
    if (
      !valid ||
      file.size <= 0 ||
      file.size > (kind === "audio" ? 20 : 2) * 1024 * 1024
    ) {
      setError(
        kind === "audio"
          ? t("karaoke.upload.invalidAudio")
          : t("karaoke.upload.invalidCover"),
      );
      return;
    }
    if (kind === "audio" && draft.has_audio) {
      setConfirmRequest({
        title: t(
          "karaoke.confirm.replaceAudioTitle",
          undefined,
          "Thay file nhạc MP3?",
        ),
        description: t("karaoke.upload.replaceAudioConfirm"),
        confirmLabel: t(
          "karaoke.confirm.replaceAudioAction",
          undefined,
          "Thay nhạc",
        ),
        variant: "destructive",
        onConfirm: () => onUpload(kind, file),
      });
      return;
    }
    onUpload(kind, file);
  }

  return (
    <div className="grid gap-4">
      <p className="text-sm text-muted">{t("karaoke.upload.instructions")}</p>
      <div className="grid gap-3 md:grid-cols-2">
        <div className="flex flex-col justify-between gap-3 rounded-xl border border-dashed border-border bg-surface-subtle/50 p-4">
          <div className="flex items-start justify-between gap-2">
            <div className="flex items-center gap-2.5">
              <span className="grid size-10 shrink-0 place-items-center rounded-lg border border-primary/20 bg-sky/70 text-primary-hover">
                <Music2 aria-hidden className="size-5" />
              </span>
              <div className="min-w-0">
                <p className="text-sm font-bold text-ink">
                  {t("karaoke.upload.audioInputAria")}
                </p>
                <p className="text-xs text-muted">
                  {draft.has_audio
                    ? t("karaoke.upload.audioSeconds", {
                        seconds: formatNumber((draft.duration_ms ?? 0) / 1000, {
                          minimumFractionDigits: 1,
                          maximumFractionDigits: 1,
                        }),
                      })
                    : t("karaoke.upload.notUploaded")}
                </p>
              </div>
            </div>
            <AdminBadge tone={draft.has_audio ? "success" : "neutral"}>
              {draft.has_audio
                ? t("karaoke.upload.coverUploaded")
                : t("karaoke.upload.notUploaded")}
            </AdminBadge>
          </div>
          <Button
            disabled={disabled}
            fullWidth={false}
            onClick={() => audio.current?.click()}
            size="admin"
            variant="secondary"
          >
            <UploadCloud aria-hidden className="size-4" />
            {draft.has_audio
              ? t("karaoke.upload.replaceAudioBtn")
              : t("karaoke.upload.uploadAudioBtn")}
          </Button>
        </div>

        <div className="flex flex-col justify-between gap-3 rounded-xl border border-dashed border-border bg-surface-subtle/50 p-4">
          <div className="flex items-start justify-between gap-2">
            <div className="flex items-center gap-2.5">
              <span className="grid size-10 shrink-0 place-items-center rounded-lg border border-border bg-white text-muted">
                <ImageIcon aria-hidden className="size-5" />
              </span>
              <div className="min-w-0">
                <p className="text-sm font-bold text-ink">
                  {t("karaoke.upload.coverInputAria")}
                </p>
                <p className="text-xs text-muted">
                  {draft.has_cover
                    ? t("karaoke.upload.coverUploaded")
                    : t("karaoke.upload.coverFallback")}
                </p>
              </div>
            </div>
            <AdminBadge tone={draft.has_cover ? "success" : "neutral"}>
              {draft.has_cover
                ? t("karaoke.upload.coverUploaded")
                : t("karaoke.upload.notUploaded")}
            </AdminBadge>
          </div>
          <Button
            disabled={disabled}
            fullWidth={false}
            onClick={() => cover.current?.click()}
            size="admin"
            variant="outline"
          >
            <UploadCloud aria-hidden className="size-4" />
            {draft.has_cover
              ? t("karaoke.upload.replaceCoverBtn")
              : t("karaoke.upload.uploadCoverBtn")}
          </Button>
        </div>
      </div>

      <input
        ref={audio}
        aria-label={t("karaoke.upload.audioInputAria")}
        type="file"
        accept=".mp3,audio/mpeg"
        className="sr-only"
        disabled={disabled}
        onChange={(e) => {
          const file = e.target.files?.[0];
          e.target.value = "";
          choose("audio", file);
        }}
      />
      <input
        ref={cover}
        aria-label={t("karaoke.upload.coverInputAria")}
        type="file"
        accept=".jpg,.jpeg,.png,.webp"
        className="sr-only"
        disabled={disabled}
        onChange={(e) => {
          const file = e.target.files?.[0];
          e.target.value = "";
          choose("cover", file);
        }}
      />

      <p className="text-sm text-muted">
        {t("karaoke.upload.statusSummary", {
          audioStatus: draft.has_audio
            ? t("karaoke.upload.audioSeconds", {
                seconds: formatNumber((draft.duration_ms ?? 0) / 1000, {
                  minimumFractionDigits: 1,
                  maximumFractionDigits: 1,
                }),
              })
            : t("karaoke.upload.notUploaded"),
          coverStatus: draft.has_cover
            ? t("karaoke.upload.coverUploaded")
            : t("karaoke.upload.coverFallback"),
        })}
      </p>
      {error && <StatusMessage tone="error">{error}</StatusMessage>}

      <KaraokeConfirmModal
        onClose={() => setConfirmRequest(null)}
        request={confirmRequest}
      />
    </div>
  );
}
