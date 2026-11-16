"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { AdminLoading, AdminPageHeader } from "@/components/admin/admin-ui";
import { LyricTimingEditor } from "@/components/admin/karaoke/lyric-timing-editor";
import { SongMediaUpload } from "@/components/admin/karaoke/song-media-upload";
import { SongMetadataForm } from "@/components/admin/karaoke/song-metadata-form";
import { Button, ButtonLink } from "@/components/common/button";
import { Card } from "@/components/common/card";
import { StatusMessage } from "@/components/common/status-message";
import { KaraokePlayer } from "@/components/karaoke/karaoke-player";
import { useAdminKaraoke } from "@/components/karaoke/karaoke-services-provider";
import { karaokeErrorMessage } from "@/lib/api/admin-karaoke-service";
import { isServiceError } from "@/lib/api/service-error";
import type { TimingFocus } from "./syllable-timing-editor";
import {
  emptyKaraokeMetadata,
  karaokeMetadataSchema,
  lyricsSchema,
  type AdminKaraokeDetail,
  type KaraokeMetadata,
  type KaraokeLyrics,
  type KaraokePreview,
  type KaraokeValidation,
} from "@/types/karaoke";

const emptyLyrics: KaraokeLyrics = { format_version: 1, lines: [] };
const fingerprint = (metadata: KaraokeMetadata, lyrics: KaraokeLyrics) =>
  JSON.stringify({ metadata, lyrics });
function metadataFrom(value: KaraokeMetadata): KaraokeMetadata {
  return {
    title: value.title,
    author: value.author,
    min_grade: value.min_grade,
    max_grade: value.max_grade,
    source_note: value.source_note,
    usage_note: value.usage_note,
  };
}
const issueLabels: Record<KaraokeValidation["issues"][number]["code"], string> =
  {
    TITLE_REQUIRED: "Chưa có tên bài hát",
    SOURCE_REQUIRED: "Chưa ghi nguồn nhạc/lời",
    USAGE_REQUIRED: "Chưa ghi quyền sử dụng",
    AUDIO_REQUIRED: "Chưa tải nhạc",
    LYRICS_REQUIRED: "Chưa có lời",
    TIMING_REQUIRED: "Thiếu mốc thời gian",
    TIMING_INVALID: "Mốc đầu/cuối chưa hợp lệ",
    TIMING_OVERLAP: "Các dòng chồng lấn hoặc sai thứ tự",
    TIMING_OUT_OF_RANGE: "Mốc vượt thời lượng",
    TIMING_AUDIO_MISMATCH: "Lời chưa được căn theo bản nhạc hiện tại",
    MEDIA_UNAVAILABLE: "Không đọc được file media",
    CONTENT_INVALID: "Dữ liệu nội dung chưa hợp lệ",
    SYLLABLES_REQUIRED: "Chưa tách tiếng cho câu",
    SYLLABLE_TEXT_MISMATCH: "Nội dung tiếng chưa khớp lời câu",
  };

export function KaraokeEditorScreen({ songId }: { songId?: string }) {
  const service = useAdminKaraoke();
  const router = useRouter();
  const [detail, setDetail] = useState<AdminKaraokeDetail | null>(null);
  const [metadata, setMetadata] =
    useState<KaraokeMetadata>(emptyKaraokeMetadata);
  const [lyrics, setLyrics] = useState<KaraokeLyrics>(emptyLyrics);
  const [saved, setSaved] = useState(
    fingerprint(emptyKaraokeMetadata, emptyLyrics),
  );
  const [loading, setLoading] = useState(!!songId);
  const [busy, setBusy] = useState("");
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [conflict, setConflict] = useState(false);
  const [preview, setPreview] = useState<KaraokePreview | null>(null);
  const [validation, setValidation] = useState<KaraokeValidation | null>(null);
  const [reviewed, setReviewed] = useState(false);
  const [focusTarget, setFocusTarget] = useState<TimingFocus>();
  const action = useRef<AbortController | null>(null);
  const dirty = fingerprint(metadata, lyrics) !== saved;
  const draft = detail?.draft;

  function adopt(data: AdminKaraokeDetail) {
    const version = data.draft ?? data.published;
    const next = version ? metadataFrom(version) : emptyKaraokeMetadata;
    const words = version?.lyrics ?? emptyLyrics;
    setDetail(data);
    setMetadata(next);
    setLyrics(words);
    setSaved(fingerprint(next, words));
    setPreview(null);
    setValidation(null);
    setReviewed(false);
    setConflict(false);
    setFocusTarget(undefined);
  }
  useEffect(() => {
    if (!songId) return;
    const controller = new AbortController();
    service
      .get(songId, controller.signal)
      .then((data) => {
        if (!controller.signal.aborted) {
          adopt(data);
          setLoading(false);
        }
      })
      .catch((e: unknown) => {
        if (!controller.signal.aborted) {
          setError(karaokeErrorMessage(e));
          setLoading(false);
        }
      });
    return () => controller.abort();
  }, [songId, service]);
  useEffect(() => () => action.current?.abort(), []);
  useEffect(() => {
    if (!dirty && !busy) return;
    const message = busy
      ? "Đang lưu/tải dữ liệu. Rời trang có thể khiến kết quả chưa được xác nhận. Tiếp tục?"
      : "Có thay đổi chưa lưu. Bạn muốn rời trang và bỏ thay đổi?";
    function unload(event: BeforeUnloadEvent) {
      event.preventDefault();
      event.returnValue = "";
    }
    function navigate(event: MouseEvent) {
      if (
        event.defaultPrevented ||
        event.button !== 0 ||
        event.ctrlKey ||
        event.metaKey ||
        event.shiftKey ||
        event.altKey
      )
        return;
      const target =
        event.target instanceof Element
          ? event.target.closest("a[href]")
          : null;
      if (
        !(target instanceof HTMLAnchorElement) ||
        target.target === "_blank" ||
        target.hasAttribute("download")
      )
        return;
      if (
        target.origin === location.origin &&
        target.pathname === location.pathname &&
        target.search === location.search
      )
        return;
      if (!window.confirm(message)) {
        event.preventDefault();
        event.stopPropagation();
      }
    }
    window.addEventListener("beforeunload", unload);
    document.addEventListener("click", navigate, true);
    return () => {
      window.removeEventListener("beforeunload", unload);
      document.removeEventListener("click", navigate, true);
    };
  }, [dirty, busy]);

  async function run<T>(
    label: string,
    request: (signal: AbortSignal) => Promise<T>,
    success: (value: T) => void,
  ) {
    if (action.current) return;
    const controller = new AbortController();
    action.current = controller;
    setBusy(label);
    setError("");
    setNotice("");
    try {
      const result = await request(controller.signal);
      if (!controller.signal.aborted) success(result);
    } catch (e) {
      if (!controller.signal.aborted) {
        setError(karaokeErrorMessage(e));
        if (isServiceError(e) && e.status === 409) {
          setConflict(true);
          setValidation(null);
          setReviewed(false);
          setPreview(null);
        }
      }
    } finally {
      action.current = null;
      if (!controller.signal.aborted) setBusy("");
    }
  }
  function changed() {
    setValidation(null);
    setReviewed(false);
    setNotice("");
  }
  const changeLyrics = useCallback((value: KaraokeLyrics) => {
    setLyrics(value);
    setValidation(null);
    setReviewed(false);
    setNotice("");
  }, []);
  function save() {
    const normalized = Object.fromEntries(
      Object.entries(metadata).map(([key, value]) => [
        key,
        typeof value === "string" ? value.trim().normalize("NFC") : value,
      ]),
    );
    const parsed = karaokeMetadataSchema.safeParse(normalized);
    const words = lyricsSchema.safeParse({
      ...lyrics,
      lines: lyrics.lines.map((l) => ({
        ...l,
        text: l.text.trim().normalize("NFC"),
      })),
    });
    if (
      !parsed.success ||
      !words.success ||
      metadata.min_grade > metadata.max_grade ||
      Object.values(metadata).some(
        (v) => typeof v === "string" && /\p{Cc}/u.test(v),
      )
    ) {
      setError(
        "Kiểm tra lớp bắt đầu/kết thúc, độ dài nội dung, dòng lời không trống và thời gian nguyên (ms). Không dùng ký tự điều khiển.",
      );
      return;
    }
    if (!songId) {
      void run(
        "Đang tạo bản nháp…",
        (signal) => service.create(parsed.data, signal),
        (data) => {
          adopt(data);
          router.replace(`/admin/karaoke/${data.song_id}/edit`);
        },
      );
    } else if (detail && draft && !conflict) {
      void run(
        "Đang lưu bản nháp…",
        (signal) =>
          service.save(
            songId,
            {
              ...parsed.data,
              lyrics: words.data,
              expected_revision: detail.revision,
              draft_version_id: draft.id,
            },
            signal,
          ),
        (data) => {
          adopt(data);
          setNotice(
            "Đã lưu bản nháp. Hãy tải nghe thử và kiểm tra lại trước khi xuất bản.",
          );
        },
      );
    }
  }
  function reload() {
    if (
      !songId ||
      (dirty &&
        !window.confirm(
          "Tải lại sẽ bỏ phần đang nhập. Bạn đã sao lưu/đối chiếu thay đổi chưa?",
        ))
    )
      return;
    void run("Đang tải lại…", (signal) => service.get(songId, signal), adopt);
  }
  function loadPreview() {
    if (!songId || !detail || !draft || dirty || conflict) return;
    // Removing the old player immediately stops audio and invalidates prior review.
    setPreview(null);
    setReviewed(false);
    void run(
      "Đang tải nghe thử…",
      (signal) => service.preview(songId, detail.revision, draft.id, signal),
      setPreview,
    );
  }
  const disabled = !!busy || conflict;
  const canPublish =
    !disabled &&
    !dirty &&
    validation?.valid &&
    validation.revision === detail?.revision &&
    preview?.revision === detail?.revision &&
    reviewed;
  if (loading) return <AdminLoading label="Đang tải chi tiết bài hát…" />;
  return (
    <div className="grid gap-6">
      <AdminPageHeader
        eyebrow="HÁT VUI"
        title={songId ? "Biên tập bài hát" : "Tạo bài hát"}
        description="Chỉ tải nhạc và lời bạn có quyền sử dụng. Không ghi âm giọng trẻ."
        actions={
          <ButtonLink href="/admin/karaoke" variant="secondary">
            Về danh sách bài hát
          </ButtonLink>
        }
      />
      {error && <StatusMessage tone="error">{error}</StatusMessage>}
      {conflict && (
        <details className="rounded-control border border-border bg-white p-4">
          <summary className="cursor-pointer font-bold">
            Sao lưu nội dung đang nhập trước khi tải lại
          </summary>
          <label className="mt-3 grid gap-2 text-sm">
            Chọn và sao chép nội dung này nếu cần giữ thay đổi của bạn.
            <textarea
              aria-label="Nội dung nháp để sao lưu"
              readOnly
              value={JSON.stringify({ ...metadata, lyrics }, null, 2)}
              rows={10}
              className="w-full rounded-control border border-border p-3 font-mono"
            />
          </label>
        </details>
      )}
      {notice && <StatusMessage tone="success">{notice}</StatusMessage>}
      {busy && (
        <p role="status" className="font-bold">
          {busy} Không đóng trang khi đang xử lý.
        </p>
      )}
      {songId && (
        <div className="flex flex-wrap items-center gap-3">
          <Button
            variant="quiet"
            className="sm:w-auto"
            disabled={!!busy}
            onClick={reload}
          >
            Tải lại từ máy chủ
          </Button>
          {detail && (
            <p className="text-sm text-muted">
              Revision {detail.revision} ·{" "}
              {dirty ? "Có thay đổi chưa lưu" : "Đã đồng bộ"}
            </p>
          )}
        </div>
      )}
      {songId && !detail ? (
        <StatusMessage>
          Chưa tải được bài hát. Bấm tải lại để thử lại.
        </StatusMessage>
      ) : detail && !draft ? (
        <Card>
          <h2 className="text-xl font-extrabold">{detail.published?.title}</h2>
          <p>
            Đây là bản đã xuất bản. Tạo bản nháp để sửa; nội dung trẻ đang dùng
            vẫn giữ nguyên cho đến khi xuất bản lại.
          </p>
          <Button
            className="sm:w-auto"
            disabled={disabled}
            onClick={() =>
              void run(
                "Đang tạo bản sửa…",
                (signal) =>
                  service.createDraft(detail.song_id, detail.revision, signal),
                adopt,
              )
            }
          >
            Tạo bản nháp từ bản xuất bản
          </Button>
        </Card>
      ) : (
        <>
          <Card>
            <h2 className="text-xl font-extrabold">1. Thông tin bài hát</h2>
            <fieldset disabled={disabled}>
              <legend className="sr-only">Thông tin bài hát</legend>
              <SongMetadataForm
                value={metadata}
                onChange={(value) => {
                  setMetadata(value);
                  changed();
                }}
              />
            </fieldset>
            <Button className="sm:w-auto" disabled={disabled} onClick={save}>
              {songId ? "Lưu bản nháp" : "Tạo bản nháp"}
            </Button>
          </Card>
          {draft && detail && (
            <>
              <Card>
                <h2 className="text-xl font-extrabold">
                  2. Nhạc nền và ảnh bìa
                </h2>
                <SongMediaUpload
                  draft={draft}
                  disabled={disabled || dirty}
                  onUpload={(kind, file) => {
                    setPreview(null);
                    void run(
                      kind === "audio"
                        ? "Đang tải và kiểm tra nhạc…"
                        : "Đang tải và kiểm tra ảnh…",
                      (signal) =>
                        service.upload(
                          detail.song_id,
                          kind,
                          file,
                          detail.revision,
                          draft.id,
                          signal,
                        ),
                      (data) => {
                        adopt(data);
                        setNotice(
                          kind === "audio"
                            ? "Đã tải nhạc; các mốc thời gian cũ đã được xóa. Hãy căn lại lời theo nhạc này."
                            : "Đã tải ảnh bìa.",
                        );
                      },
                    );
                  }}
                />
              </Card>
              <Card>
                <h2 className="text-xl font-extrabold">
                  3. Lời, căn thời gian và nghe thử
                </h2>
                <p className="text-sm text-muted">
                  Lưu nháp trước khi tải bản nghe thử. Sau khi tải, bạn có thể
                  nghe và sửa mốc ngay; bộ phát dùng lời đang nhập. Lưu lại rồi
                  nghe thử lần cuối trước khi xuất bản.
                </p>
                <Button
                  className="sm:w-auto"
                  variant="secondary"
                  disabled={disabled || dirty || !draft.has_audio}
                  onClick={loadPreview}
                >
                  {preview
                    ? "Tải lại bản nghe thử"
                    : "Tải bản nghe thử / Căn thời gian"}
                </Button>
                {preview ? (
                  <KaraokePlayer
                    source={preview}
                    lyrics={lyrics}
                    onPlayed={() => {
                      if (!dirty) setReviewed(true);
                    }}
                  >
                    {(player) => (
                      <LyricTimingEditor
                        lyrics={lyrics}
                        duration={draft.duration_ms}
                        disabled={disabled}
                        player={player}
                        onChange={changeLyrics}
                        onSave={save}
                        focusTarget={focusTarget}
                      />
                    )}
                  </KaraokePlayer>
                ) : (
                  <LyricTimingEditor
                    lyrics={lyrics}
                    duration={draft.duration_ms}
                    disabled={disabled}
                    onChange={changeLyrics}
                    onSave={save}
                    focusTarget={focusTarget}
                  />
                )}
                <Button
                  className="sm:w-auto"
                  disabled={disabled}
                  onClick={save}
                >
                  Lưu lời và thời gian
                </Button>
              </Card>
              <Card>
                <h2 className="text-xl font-extrabold">
                  4. Kiểm tra và xuất bản
                </h2>
                <p>
                  Bản nháp cần được lưu, kiểm tra hợp lệ và bấm phát nghe thử
                  đúng revision trước khi xuất bản. Backend kiểm tra lại một lần
                  nữa khi xuất bản.
                </p>
                <Button
                  variant="secondary"
                  className="sm:w-auto"
                  disabled={disabled || dirty}
                  onClick={() =>
                    void run(
                      "Đang kiểm tra nội dung và file…",
                      (signal) =>
                        service.validate(
                          detail.song_id,
                          detail.revision,
                          draft.id,
                          signal,
                        ),
                      setValidation,
                    )
                  }
                >
                  Kiểm tra điều kiện xuất bản
                </Button>
                {validation && (
                  <StatusMessage
                    tone={validation.valid ? "success" : "warning"}
                    title={
                      validation.valid ? "Bản nháp hợp lệ" : "Chưa thể xuất bản"
                    }
                  >
                    {validation.valid ? (
                      "Hãy nghe thử, đối chiếu lời với nhạc rồi xuất bản."
                    ) : (
                      <ul className="list-inside list-disc">
                        {validation.issues.map((issue, i) => {
                          const index = lyrics.lines.findIndex(
                            (l) => l.id === issue.line_id,
                          );
                          return (
                            <li key={i}>
                              {issue.line_id ? (
                                <button
                                  type="button"
                                  className="min-h-11 text-left underline"
                                  onClick={() =>
                                    setFocusTarget({
                                      lineId: issue.line_id!,
                                      syllableId:
                                        issue.syllable_id ?? undefined,
                                      request: (focusTarget?.request ?? 0) + 1,
                                    })
                                  }
                                >
                                  {issueLabels[issue.code]}
                                  {index >= 0 ? ` · Dòng ${index + 1}` : ""}
                                </button>
                              ) : (
                                issueLabels[issue.code]
                              )}
                            </li>
                          );
                        })}
                      </ul>
                    )}
                  </StatusMessage>
                )}
                <Button
                  className="sm:w-auto"
                  disabled={!canPublish}
                  onClick={() => {
                    if (
                      window.confirm(
                        "Xuất bản bản nháp này cho trẻ? Bản đã xuất bản trước đó sẽ được thay thế.",
                      )
                    )
                      void run(
                        "Đang xuất bản…",
                        (signal) =>
                          service.publish(
                            detail.song_id,
                            detail.revision,
                            draft.id,
                            signal,
                          ),
                        (data) => {
                          adopt(data);
                          setNotice("Đã xuất bản bài hát.");
                        },
                      );
                  }}
                >
                  Xuất bản bài hát
                </Button>
              </Card>
            </>
          )}
        </>
      )}
    </div>
  );
}
