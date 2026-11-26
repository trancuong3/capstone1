"use client";

import { useRef, useState } from "react";
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
    if (
      kind === "audio" &&
      draft.has_audio &&
      !window.confirm(t("karaoke.upload.replaceAudioConfirm"))
    )
      return;
    onUpload(kind, file);
  }
  return (
    <div className="grid gap-4">
      <p className="text-sm text-muted">{t("karaoke.upload.instructions")}</p>
      <div className="flex flex-wrap gap-3">
        <Button
          className="sm:w-auto"
          disabled={disabled}
          variant="secondary"
          onClick={() => audio.current?.click()}
        >
          {draft.has_audio
            ? t("karaoke.upload.replaceAudioBtn")
            : t("karaoke.upload.uploadAudioBtn")}
        </Button>
        <Button
          className="sm:w-auto"
          disabled={disabled}
          variant="secondary"
          onClick={() => cover.current?.click()}
        >
          {draft.has_cover
            ? t("karaoke.upload.replaceCoverBtn")
            : t("karaoke.upload.uploadCoverBtn")}
        </Button>
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
      </div>
      <p className="text-sm">
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
    </div>
  );
}
