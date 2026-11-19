"use client";
import {
  useEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
} from "react";
import { useRouter } from "next/navigation";
import { AdminPageHeader } from "@/components/admin/admin-ui";
import {
  SongMetadataForm,
  karaokeInputClass,
} from "@/components/admin/karaoke/song-metadata-form";
import { KaraokeProcessingStatus } from "@/components/admin/karaoke/karaoke-processing-status";
import { KaraokeReviewPanel } from "@/components/admin/karaoke/karaoke-review-panel";
import { Button, ButtonLink } from "@/components/common/button";
import { Card } from "@/components/common/card";
import { StatusMessage } from "@/components/common/status-message";
import { useAdminKaraoke } from "@/components/karaoke/karaoke-services-provider";
import { KaraokeWizardController } from "@/lib/karaoke/wizard-controller";
import { suggestRepeatedLyrics } from "@/lib/karaoke/wizard-lyrics";
import { karaokeErrorMessage } from "@/lib/api/admin-karaoke-service";
import type { AdminKaraokeDetail } from "@/types/karaoke";
import type { ProcessingCapabilities } from "@/types/karaoke-processing";

export function KaraokeWizardScreen({
  initial,
  capabilities,
}: {
  initial: AdminKaraokeDetail | null;
  capabilities: ProcessingCapabilities | null;
}) {
  const service = useAdminKaraoke();
  const router = useRouter();
  const [controller] = useState(
    () => new KaraokeWizardController(service, capabilities, initial),
  );
  const view = useSyncExternalStore(
    controller.subscribe,
    controller.getSnapshot,
    controller.getSnapshot,
  );
  const [switchError, setSwitchError] = useState("");
  const [inputExpansion, setInputExpansion] = useState<{
    jobId: string | undefined;
    open: boolean;
  }>();
  const lyricConsent = useRef(false);
  const [repeatUndo, setRepeatUndo] = useState<{
    before: string;
    after: string;
  }>();
  const repeatProposal = useMemo(
    () => suggestRepeatedLyrics(view.rawLyrics),
    [view.rawLyrics],
  );
  useEffect(() => {
    controller.activate();
    return controller.suspend;
  }, [controller]);
  useEffect(() => {
    function unload(event: BeforeUnloadEvent) {
      if (controller.hasUnsaved()) {
        event.preventDefault();
        event.returnValue = "";
      }
    }
    function navigate(event: MouseEvent) {
      if (
        !controller.hasUnsaved() ||
        event.defaultPrevented ||
        event.button !== 0 ||
        event.ctrlKey ||
        event.metaKey ||
        event.shiftKey ||
        event.altKey
      )
        return;
      const anchor =
        event.target instanceof Element
          ? event.target.closest("a[href]")
          : null;
      if (
        !(anchor instanceof HTMLAnchorElement) ||
        anchor.target === "_blank" ||
        anchor.hasAttribute("download")
      )
        return;
      if (
        !window.confirm(
          "Có file hoặc nội dung chưa được xác nhận lưu. Rời trang có thể mất phần đang nhập; job đã gửi vẫn tiếp tục. Bạn muốn rời trang?",
        )
      ) {
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
  }, [controller]);
  const detail = view.detail;
  const draft = detail?.draft;
  const locked = controller.isLocked();
  const saveError = view.save?.error || view.processing?.error;
  const metaErrors = Object.fromEntries(
    (view.validation?.issues ?? []).flatMap((issue) =>
      issue.code === "SOURCE_REQUIRED"
        ? [["source_note", "Hãy ghi nguồn nhạc và lời trước khi xuất bản."]]
        : issue.code === "USAGE_REQUIRED"
          ? [["usage_note", "Hãy xác nhận quyền sử dụng nội dung."]]
          : issue.code === "TITLE_REQUIRED"
            ? [["title", "Hãy đặt tên bài hát."]]
            : [],
    ),
  );
  async function advanced() {
    setSwitchError("");
    try {
      await controller.flush();
      router.push(
        detail
          ? `/admin/karaoke/${detail.song_id}/edit?mode=advanced`
          : "/admin/karaoke/new?mode=advanced",
      );
    } catch (error) {
      setSwitchError(
        error instanceof Error
          ? error.message
          : "Cần lưu bản nháp trước khi chuyển chế độ.",
      );
    }
  }
  function choose(kind: "audio" | "reference" | "cover", file?: File) {
    if (!file) return;
    if (
      kind === "audio" &&
      draft?.has_audio &&
      !window.confirm(
        "Thay nhạc sẽ xóa mốc lời trong bản nháp sau khi tải thành công. Bạn muốn tiếp tục?",
      )
    )
      return;
    controller.chooseFile(kind, file);
  }
  const pendingFiles = !!view.file || !!view.reference || !!view.cover;
  const job = view.processing?.job;
  const hasMetaErrors = Object.keys(metaErrors).length > 0;
  const inputOpen =
    hasMetaErrors ||
    (inputExpansion && inputExpansion.jobId === job?.id
      ? inputExpansion.open
      : !job || ["FAILED", "CANCELLED", "STALE"].includes(job.status));
  const currentStep =
    view.preview?.kind === "draft" || job?.status === "APPLIED"
      ? 3
      : job &&
          ["QUEUED", "RUNNING", "READY", "NEEDS_REVIEW"].includes(job.status)
        ? 2
        : 1;
  return (
    <div className="grid min-w-0 gap-6">
      <AdminPageHeader
        eyebrow="KARAOKE CHO BÉ"
        title="Tạo karaoke dễ dàng"
        description="Tải bài hát có giọng, dán lời đúng bản thu; sau đó nghe kiểm tra và xuất bản."
        actions={
          <ButtonLink variant="quiet" href="/admin/karaoke">
            Danh sách bài hát
          </ButtonLink>
        }
      />
      <ol
        aria-label="Các bước tạo karaoke"
        className="grid gap-2 sm:grid-cols-3"
      >
        {["1. Thêm nhạc và lời", "2. Xử lý", "3. Nghe và xuất bản"].map(
          (label, index) => (
            <li
              key={label}
              aria-current={currentStep === index + 1 ? "step" : undefined}
              className={
                currentStep === index + 1
                  ? "rounded-control bg-primary p-3 font-bold text-white"
                  : "rounded-control border border-border p-3 font-bold text-muted"
              }
            >
              {label}
            </li>
          ),
        )}
      </ol>
      {detail && (
        <StatusMessage tone="info">
          Bản nháp đã có trên máy chủ.{" "}
          <a
            className="break-all underline"
            href={`/admin/karaoke/${detail.song_id}/edit`}
          >
            Mở lại bài hát đã lưu
          </a>
          . File chưa tải xong vẫn chỉ nằm ở trình duyệt.
        </StatusMessage>
      )}
      {!controller.canProcess() && (
        <StatusMessage tone="info">
          Tự động tạo karaoke hiện chưa được bật hoặc cấu hình đầy đủ. Bạn vẫn
          có thể chỉnh sửa và duyệt bản nháp đã có, hoặc dùng chế độ nâng cao.
        </StatusMessage>
      )}
      {(view.error || saveError || switchError) && (
        <StatusMessage tone="error">
          {view.error ||
            (saveError ? karaokeErrorMessage(saveError) : switchError)}
          {detail && (
            <Button
              variant="quiet"
              className="mt-3 sm:w-auto"
              disabled={!!view.busy || !!view.save?.busy}
              onClick={() => {
                if (
                  window.confirm(
                    "Nạp bản trên máy chủ sẽ bỏ phần đang nhập và lựa chọn file chưa tải. Hãy sao chép nội dung cần giữ trước. Tiếp tục?",
                  )
                )
                  void controller.reloadSaved();
              }}
            >
              Đối chiếu / nạp bản đã lưu
            </Button>
          )}
        </StatusMessage>
      )}
      {view.notice && (
        <StatusMessage tone="success">{view.notice}</StatusMessage>
      )}
      {detail && !draft ? (
        <Card>
          <h2 className="text-xl font-extrabold">Bài hát đã xuất bản</h2>
          <p>
            Muốn thay đổi nội dung, hãy tạo một bản nháp mới từ danh sách bài
            hát.
          </p>
          <ButtonLink href="/admin/karaoke" variant="secondary">
            Về danh sách
          </ButtonLink>
        </Card>
      ) : (
        <>
          <Card className="min-w-0">
            <details
              open={inputOpen}
              onFocusCapture={() => {
                if (hasMetaErrors)
                  setInputExpansion({ jobId: job?.id, open: true });
              }}
            >
              <summary
                className="min-h-12 cursor-pointer py-3 text-xl font-extrabold"
                onClick={(event) => {
                  event.preventDefault();
                  setInputExpansion({ jobId: job?.id, open: !inputOpen });
                }}
              >
                {job && !inputOpen
                  ? "1. Nhạc và lời đã lưu — xem / chỉnh sửa"
                  : "1. Thêm nhạc và lời"}
              </summary>
              <div className="grid min-w-0 gap-5 pt-3">
                <fieldset className="grid min-w-0 gap-5" disabled={locked}>
                  <SongMetadataForm
                    variant="compact"
                    value={view.metadata}
                    onChange={controller.setMetadata}
                    errors={metaErrors}
                  />
                  <label className="grid gap-2 font-bold">
                    {view.mode === "VOCAL_TRACK"
                      ? "Bài hát có giọng (MP3)"
                      : "Nhạc nền (MP3)"}
                    <input
                      aria-label={
                        view.mode === "VOCAL_TRACK"
                          ? "Bài hát có giọng (MP3)"
                          : "Nhạc nền (MP3)"
                      }
                      className={karaokeInputClass}
                      type="file"
                      accept=".mp3,audio/mpeg"
                      onChange={(event) => {
                        choose("audio", event.target.files?.[0]);
                        event.target.value = "";
                      }}
                    />
                    <span className="break-words text-sm font-normal text-muted">
                      {view.file?.name ??
                        (draft?.has_audio
                          ? "Đã có nhạc trên máy chủ"
                          : "Chưa chọn nhạc")}{" "}
                      · MP3 tối đa 20 MiB, 5 phút.
                    </span>
                  </label>
                  <p className="text-muted">
                    Dùng bản có giọng hát để hệ thống tự căn lời. Nhạc không lời
                    thuần cần bản hát đối chiếu cùng bản phối hoặc căn thủ công.
                  </p>
                  <label className="grid gap-2 font-bold">
                    Lời bài hát
                    <textarea
                      aria-label="Lời bài hát"
                      className={`${karaokeInputClass} min-h-52`}
                      value={view.rawLyrics}
                      maxLength={50000}
                      placeholder="Dán lời đúng bản thu, mỗi câu một dòng. Viết đầy đủ các câu lặp."
                      aria-invalid={!!view.lyricsError}
                      aria-describedby="karaoke-lyrics-help"
                      onBlur={() => {
                        lyricConsent.current = false;
                      }}
                      onChange={(event) => {
                        if (
                          !lyricConsent.current &&
                          view.lyrics.lines.some((line) =>
                            line.syllables?.some(
                              (s) => s.start_ms !== null || s.end_ms !== null,
                            ),
                          )
                        ) {
                          if (
                            !window.confirm(
                              "Đổi lời có thể làm các tiếng bị sửa mất mốc thời gian và cần duyệt lại. Tiếp tục?",
                            )
                          )
                            return;
                          lyricConsent.current = true;
                        }
                        controller.setRawLyrics(event.target.value);
                      }}
                    />
                    <span
                      id="karaoke-lyrics-help"
                      className="text-sm font-normal text-muted"
                    >
                      Không cần nhập mili giây, JSON hay LRC. Hệ thống không tự
                      thêm lời còn thiếu. Ký hiệu ×2 ở cuối câu chỉ được mở rộng
                      khi bạn xác nhận; ký hiệu trên dòng riêng cần sửa thủ
                      công.
                    </span>
                  </label>
                  {view.lyricsError && (
                    <StatusMessage tone="error">
                      {view.lyricsError}
                    </StatusMessage>
                  )}
                  {repeatProposal && (
                    <StatusMessage tone="info">
                      {repeatProposal.error ??
                        `Có ${repeatProposal.markedLines} câu có ký hiệu lặp. Mỗi ký hiệu chỉ lặp lại chính câu đó, không phải cả đoạn.`}
                      {!repeatProposal.error && (
                        <Button
                          type="button"
                          variant="secondary"
                          className="mt-3 sm:w-auto"
                          onClick={() => {
                            if (
                              window.confirm(
                                "Mở rộng ký hiệu thành các câu lặp đầy đủ theo đúng số lần đã ghi? Lời bị thay đổi sẽ mất mốc cũ và cần duyệt lại. Hãy kiểm tra thứ tự với bản thu.",
                              )
                            ) {
                              setRepeatUndo({
                                before: view.rawLyrics,
                                after: repeatProposal.text,
                              });
                              controller.setRawLyrics(repeatProposal.text);
                            }
                          }}
                        >
                          Mở rộng câu lặp
                        </Button>
                      )}
                    </StatusMessage>
                  )}
                  {repeatUndo && repeatUndo.after === view.rawLyrics && (
                    <Button
                      type="button"
                      variant="quiet"
                      className="sm:w-auto"
                      onClick={() => {
                        controller.setRawLyrics(repeatUndo.before);
                        setRepeatUndo(undefined);
                      }}
                    >
                      Hoàn tác mở rộng lời
                    </Button>
                  )}
                  <details>
                    <summary className="min-h-12 cursor-pointer py-3 font-bold">
                      Tôi đã có nhạc nền / Thêm ảnh bìa
                    </summary>
                    <div className="grid gap-4 pt-3">
                      <label className="grid gap-2">
                        Loại nhạc
                        <select
                          className={karaokeInputClass}
                          value={view.mode}
                          onChange={(e) =>
                            controller.setMode(
                              e.target.value as typeof view.mode,
                            )
                          }
                        >
                          <option value="VOCAL_TRACK">
                            Bản có giọng hát — tự chuẩn bị nhạc nền
                          </option>
                          <option value="INSTRUMENTAL_WITH_REFERENCE">
                            Nhạc nền và bản hát đối chiếu
                          </option>
                        </select>
                      </label>
                      {view.mode === "INSTRUMENTAL_WITH_REFERENCE" && (
                        <label className="grid gap-2">
                          Bản hát đối chiếu (MP3)
                          <input
                            className={karaokeInputClass}
                            type="file"
                            accept=".mp3,audio/mpeg"
                            onChange={(event) => {
                              choose("reference", event.target.files?.[0]);
                              event.target.value = "";
                            }}
                          />
                          <span className="break-words text-sm text-muted">
                            {view.reference?.name ??
                              (draft?.has_reference_audio
                                ? "Đã có bản hát đối chiếu"
                                : "Chưa chọn bản hát đối chiếu")}
                            . Hai bản cần cùng phần nhạc dạo, nhịp và bản phối.
                          </span>
                        </label>
                      )}
                      <label className="grid gap-2">
                        Ảnh bìa (tùy chọn)
                        <input
                          className={karaokeInputClass}
                          type="file"
                          accept=".jpg,.jpeg,.png,.webp"
                          onChange={(event) => {
                            choose("cover", event.target.files?.[0]);
                            event.target.value = "";
                          }}
                        />
                        <span className="text-sm text-muted">
                          {view.cover?.name ??
                            "JPEG/PNG/WebP tối đa 2 MiB; có thể để trống."}
                        </span>
                      </label>
                    </div>
                  </details>
                </fieldset>
                <div className="flex flex-wrap gap-3">
                  <Button
                    disabled={
                      locked || !controller.canProcess() || !!view.lyricsError
                    }
                    isLoading={!!view.busy}
                    onClick={() => void controller.createAndProcess()}
                  >
                    {view.busy ||
                      (detail ? "Tạo / căn lại karaoke" : "Tạo karaoke")}
                  </Button>
                  <Button
                    variant="quiet"
                    disabled={
                      !!view.busy ||
                      !!view.processing?.action ||
                      !!view.save?.busy
                    }
                    onClick={() => void advanced()}
                  >
                    Chỉnh sửa nâng cao
                  </Button>
                </div>
                <p
                  role="status"
                  aria-live="polite"
                  className="text-sm text-muted"
                >
                  {view.busy ||
                    (view.save?.state === "saving"
                      ? "Đang tự lưu…"
                      : view.save?.state === "saved"
                        ? "Đã lưu bản nháp"
                        : view.save?.dirty
                          ? "Có thay đổi chưa lưu"
                          : "Chỉ tạo bản nháp khi bạn bấm Tạo karaoke.")}
                </p>
              </div>
            </details>
          </Card>
          {view.processing?.job && (
            <Card>
              <KaraokeProcessingStatus
                job={view.processing.job}
                nowMs={view.nowMs}
                queueWarningAfterSeconds={
                  capabilities?.queue_warning_after_seconds ?? 120
                }
                busy={
                  !!view.busy || !!view.processing.action || !!view.save?.busy
                }
                onCancel={() => void controller.cancel()}
                onRetry={(ack) => void controller.retry(ack)}
                onPreview={() => void controller.loadStagingPreview()}
                onApply={() => void controller.apply()}
              />
            </Card>
          )}
          {draft?.has_audio && !locked && view.preview?.kind !== "draft" && (
            <Button
              variant="secondary"
              disabled={
                !!view.busy ||
                !!view.save?.busy ||
                pendingFiles ||
                !!view.lyricsError
              }
              onClick={() => void controller.loadDraftPreview()}
            >
              Nghe và kiểm tra bản nháp đã lưu
            </Button>
          )}
          {view.preview && detail && (
            <Card className="min-w-0">
              <KaraokeReviewPanel
                preview={view.preview}
                detail={detail}
                validation={view.validation}
                busy={!!view.busy || !!view.processing?.action}
                dirty={!!view.save?.dirty || pendingFiles || !!view.lyricsError}
                lyrics={view.lyrics}
                reference={view.referencePreview}
                referenceError={view.referenceError}
                onReference={() => void controller.loadReference()}
                onReload={() => {
                  if (view.preview?.kind === "staging")
                    void controller.loadStagingPreview();
                  else void controller.loadDraftPreview();
                }}
                onApply={() => void controller.apply()}
                onConfirm={(ids, listened) =>
                  void controller.confirmReview(ids, listened)
                }
                onChangeLyrics={controller.setTimedLyrics}
                onSave={() => void controller.loadDraftPreview()}
                onPublish={() => {
                  if (
                    window.confirm(
                      "Xuất bản đúng bản đã nghe và duyệt này cho trẻ?",
                    )
                  )
                    void controller.publish();
                }}
                canPublish={!!controller.canPublish()}
              />
            </Card>
          )}
        </>
      )}
    </div>
  );
}
