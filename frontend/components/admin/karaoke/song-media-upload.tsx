"use client";

import { useRef, useState } from "react";
import { StatusMessage } from "@/components/common/status-message";
import { Button } from "@/components/common/button";
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
          ? "Chọn MP3 không rỗng, tối đa 20 MiB và 5 phút."
          : "Chọn JPEG/PNG/WebP không rỗng, tối đa 2 MiB, mỗi chiều tối đa 4096 px.",
      );
      return;
    }
    if (
      kind === "audio" &&
      draft.has_audio &&
      !window.confirm(
        "Thay nhạc sẽ xóa toàn bộ mốc thời gian của lời trong bản nháp. Bạn có muốn tiếp tục?",
      )
    )
      return;
    onUpload(kind, file);
  }
  return (
    <div className="grid gap-4">
      <p className="text-sm text-muted">
        Lưu thay đổi trước khi tải file. Backend kiểm tra định dạng thật và thời
        lượng. Upload được lưu ngay vào bản nháp, không phải bản xuất bản.
      </p>
      <div className="flex flex-wrap gap-3">
        <Button
          className="sm:w-auto"
          disabled={disabled}
          variant="secondary"
          onClick={() => audio.current?.click()}
        >
          {draft.has_audio ? "Thay nhạc MP3" : "Tải nhạc MP3"}
        </Button>
        <Button
          className="sm:w-auto"
          disabled={disabled}
          variant="secondary"
          onClick={() => cover.current?.click()}
        >
          {draft.has_cover ? "Thay ảnh bìa" : "Tải ảnh bìa (tùy chọn)"}
        </Button>
        <input
          ref={audio}
          aria-label="File nhạc MP3"
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
          aria-label="File ảnh bìa"
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
        Nhạc:{" "}
        {draft.has_audio
          ? `${((draft.duration_ms ?? 0) / 1000).toFixed(1)} giây`
          : "Chưa tải"}{" "}
        · Ảnh:{" "}
        {draft.has_cover ? "Đã tải" : "Chưa có (dùng biểu tượng mặc định)"}
      </p>
      {error && <StatusMessage tone="error">{error}</StatusMessage>}
    </div>
  );
}
