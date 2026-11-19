"use client";
import { useState } from "react";
import { LyricTimingEditor } from "@/components/admin/karaoke/lyric-timing-editor";
import type { TimingFocus } from "@/components/admin/karaoke/syllable-timing-editor";
import { Button } from "@/components/common/button";
import { StatusMessage } from "@/components/common/status-message";
import { KaraokePlayer } from "@/components/karaoke/karaoke-player";
import type { WizardPreview } from "@/lib/karaoke/wizard-controller";
import type {
  AdminKaraokeDetail,
  KaraokeLyrics,
  KaraokePreview,
  KaraokeValidation,
} from "@/types/karaoke";
import type {
  DraftReferencePreview,
  QualityFlag,
} from "@/types/karaoke-processing";
const flagLabels = {
  LOW_ALIGNMENT_SUPPORT: "Đoạn này cần nghe kỹ vì bằng chứng căn lời còn yếu.",
  LYRIC_MISMATCH: "Kiểm tra lời có khớp bản hát không.",
  AMBIGUOUS_REPEAT: "Kiểm tra đúng lần lặp của câu hát.",
  UNALIGNED_SYLLABLES: "Có tiếng chưa xác định đủ mốc thời gian.",
  HELD_NOTE_UNCERTAIN: "Kiểm tra phần ngân và mốc kết thúc tiếng.",
  BACKGROUND_ARTIFACT: "Nghe kiểm tra nhạc nền sau khi tách giọng.",
} satisfies Record<QualityFlag["message_key"], string>;
type Props = {
  preview: WizardPreview;
  detail: AdminKaraokeDetail;
  validation: KaraokeValidation | null;
  busy: boolean;
  dirty: boolean;
  lyrics: KaraokeLyrics;
  reference: DraftReferencePreview | null;
  referenceError: string;
  onReference: () => void;
  onReload: () => void;
  onApply: () => void;
  onConfirm: (ids: string[], listened: boolean) => void;
  onChangeLyrics: (lyrics: KaraokeLyrics) => void;
  onSave: () => void;
  onPublish: () => void;
  canPublish: boolean;
};
export function KaraokeReviewPanel(props: Props) {
  const fingerprint =
    props.preview.kind === "staging"
      ? props.preview.source.input_fingerprint
      : (props.detail.processing_review?.current_content_fingerprint ??
        String(props.detail.revision));
  return (
    <ReviewBody
      key={`${props.preview.kind}:${props.detail.draft?.id ?? fingerprint}`}
      {...props}
    />
  );
}
function ReviewBody({
  preview,
  detail,
  validation,
  busy,
  dirty,
  lyrics,
  reference,
  referenceError,
  onReference,
  onReload,
  onApply,
  onConfirm,
  onChangeLyrics,
  onSave,
  onPublish,
  canPublish,
}: Props) {
  const currentFingerprint =
    preview.kind === "staging"
      ? preview.source.input_fingerprint
      : (detail.processing_review?.current_content_fingerprint ??
        String(detail.revision));
  const [consent, setConsent] = useState({
    fingerprint: currentFingerprint,
    listened: false,
    acknowledged: [] as string[],
  });
  const listened =
    consent.fingerprint === currentFingerprint && consent.listened;
  const acknowledged =
    consent.fingerprint === currentFingerprint ? consent.acknowledged : [];
  const [useReference, setUseReference] = useState(false);
  const [playbackGeneration, setPlaybackGeneration] = useState(0);
  const [editing, setEditing] = useState(false);
  const [focus, setFocus] = useState<TimingFocus>();
  const staging = preview.kind === "staging";
  const flags = staging
    ? preview.source.quality_flags
    : (detail.processing_review?.quality_flags ?? []);
  const structural =
    validation?.issues.filter(
      (issue) => issue.code !== "PROCESSING_REVIEW_REQUIRED",
    ) ?? [];
  const source: KaraokePreview = staging
    ? {
        song_id: preview.source.song_id,
        version_id: preview.source.draft_version_id,
        revision: preview.source.base_revision,
        title: preview.source.title,
        author: preview.source.author,
        duration_ms: preview.source.duration_ms,
        audio_url: preview.source.audio_url,
        audio_url_expires_at: preview.source.audio_url_expires_at,
        cover_url: preview.source.cover_url,
        lyrics: preview.source.lyrics,
      }
    : preview.source;
  const referenceUrl = staging
    ? preview.source.reference_audio_url
    : reference?.reference_audio_url;
  const referenceExpiry = staging
    ? preview.source.reference_audio_url_expires_at
    : reference?.reference_audio_url_expires_at;
  const selectedSource =
    useReference && referenceUrl && referenceExpiry
      ? {
          ...source,
          audio_url: referenceUrl,
          audio_url_expires_at: referenceExpiry,
        }
      : source;
  const ackComplete = flags.every((flag) => acknowledged.includes(flag.id));
  const reviewed = !staging && detail.processing_review?.reviewed === true;
  function reloadSelectedSource() {
    // Unmount the old audio synchronously; renewing a URL never starts playback.
    setPlaybackGeneration((generation) => generation + 1);
    if (useReference && !staging) onReference();
    else onReload();
  }
  return (
    <section
      className="grid gap-5"
      aria-label={
        staging ? "Nghe kết quả chưa áp dụng" : "Nghe và duyệt bản nháp"
      }
    >
      <h2 className="text-xl font-extrabold">
        {staging ? "Kết quả chưa áp dụng" : "3. Nghe, kiểm tra và xuất bản"}
      </h2>
      <StatusMessage tone="info">
        {staging
          ? "Đây là kết quả xử lý riêng, chưa thay bản nháp và chưa xuất bản."
          : "Nghe nhạc nền, đối chiếu lời và sửa các mốc còn thiếu. Bắt đầu phát không đồng nghĩa đã xác nhận duyệt."}
      </StatusMessage>
      <div className="flex flex-wrap gap-3">
        <Button
          variant="secondary"
          className="sm:w-auto"
          disabled={busy || !useReference}
          onClick={() => setUseReference(false)}
        >
          Nghe nhạc nền
        </Button>
        {referenceUrl && referenceExpiry ? (
          <Button
            variant="secondary"
            className="sm:w-auto"
            disabled={busy || useReference}
            onClick={() => setUseReference(true)}
          >
            Nghe bản hát đối chiếu
          </Button>
        ) : (
          !staging && (
            <Button
              variant="secondary"
              className="sm:w-auto"
              disabled={busy || dirty}
              onClick={onReference}
            >
              Tải bản hát đối chiếu
            </Button>
          )
        )}
        <Button
          variant="quiet"
          className="sm:w-auto"
          disabled={busy || dirty}
          onClick={reloadSelectedSource}
        >
          {useReference ? "Làm mới bản hát đối chiếu" : "Làm mới bản nghe thử"}
        </Button>
      </div>
      {referenceError && (
        <StatusMessage tone="info">{referenceError}</StatusMessage>
      )}
      <KaraokePlayer
        key={playbackGeneration}
        source={selectedSource}
        label={
          useReference && referenceUrl
            ? "Bản hát đối chiếu"
            : staging
              ? "Nghe kết quả xử lý"
              : "Nghe bản nháp"
        }
        lyrics={staging ? source.lyrics : lyrics}
        onReload={reloadSelectedSource}
      >
        {(player) => (
          <>
            {flags.length > 0 && (
              <div className="grid gap-3" aria-label="Các chỗ cần kiểm tra">
                {flags.map((flag) => {
                  const target = lyrics.lines.find(
                    (line) => line.id === flag.line_id,
                  );
                  const unit = target?.syllables?.find((s) =>
                    flag.syllable_ids.includes(s.id),
                  );
                  return (
                    <div
                      key={flag.id}
                      className="grid gap-2 rounded-control border border-border p-4"
                    >
                      <p>{flagLabels[flag.message_key]}</p>
                      <p className="text-sm text-muted">
                        {target
                          ? target.text
                          : "Cảnh báo của lượt xử lý trước; câu gốc đã đổi hoặc đây là cảnh báo toàn bài. Hãy kiểm tra toàn bài."}
                      </p>
                      {!staging && target && (
                        <Button
                          variant="quiet"
                          className="sm:w-auto"
                          disabled={busy}
                          onClick={() => {
                            player.pause();
                            setUseReference(false);
                            setEditing(true);
                            setFocus({
                              lineId: target.id,
                              syllableId: unit?.id,
                              request: Date.now(),
                            });
                          }}
                        >
                          Kiểm tra câu được đánh dấu
                        </Button>
                      )}
                      {!staging && (
                        <label className="flex items-start gap-3">
                          <input
                            className="mt-1 size-5"
                            type="checkbox"
                            checked={acknowledged.includes(flag.id)}
                            disabled={busy}
                            onChange={(e) =>
                              setConsent({
                                fingerprint: currentFingerprint,
                                listened,
                                acknowledged: e.target.checked
                                  ? [...acknowledged, flag.id]
                                  : acknowledged.filter((id) => id !== flag.id),
                              })
                            }
                          />
                          Tôi đã kiểm tra và xử lý cảnh báo này.
                        </label>
                      )}
                    </div>
                  );
                })}
              </div>
            )}
            {!staging && (
              <details
                open={editing}
                onToggle={(event) => setEditing(event.currentTarget.open)}
              >
                <summary className="min-h-12 cursor-pointer py-3 font-bold text-primary-hover">
                  Chỉnh thời gian và lời nâng cao
                </summary>
                <LyricTimingEditor
                  lyrics={lyrics}
                  duration={source.duration_ms}
                  disabled={busy || !!useReference}
                  player={player}
                  onChange={onChangeLyrics}
                  onSave={onSave}
                  focusTarget={focus}
                />
              </details>
            )}
          </>
        )}
      </KaraokePlayer>
      {staging ? (
        <Button disabled={busy} onClick={onApply}>
          Dùng kết quả này trong bản nháp
        </Button>
      ) : (
        <>
          {structural.length > 0 && (
            <StatusMessage tone="warning">
              <p>
                Cần sửa trước khi duyệt/xuất bản; checkbox không bỏ qua các lỗi
                này:
              </p>
              <ul className="list-disc pl-5">
                {structural.slice(0, 15).map((issue, index) => (
                  <li key={index}>
                    {issue.code === "SOURCE_REQUIRED"
                      ? "Bổ sung nguồn nhạc và lời trong Thông tin thêm."
                      : issue.code === "USAGE_REQUIRED"
                        ? "Bổ sung quyền sử dụng trong Thông tin thêm."
                        : issue.code === "TITLE_REQUIRED"
                          ? "Bổ sung tên bài hát."
                          : issue.field === "lyrics"
                            ? "Kiểm tra lời và mốc đầu/cuối từng câu, từng tiếng trong trình chỉnh sửa."
                            : "Kiểm tra nội dung và file nhạc đã lưu."}
                  </li>
                ))}
              </ul>
            </StatusMessage>
          )}
          <label className="flex items-start gap-3">
            <input
              className="mt-1 size-5"
              type="checkbox"
              checked={listened}
              disabled={busy}
              onChange={(e) =>
                setConsent({
                  fingerprint: currentFingerprint,
                  listened: e.target.checked,
                  acknowledged,
                })
              }
            />
            Tôi đã nghe nhạc nền, kiểm tra lời chạy và các chỗ được đánh dấu của
            bản nháp này.
          </label>
          <Button
            variant="secondary"
            disabled={
              busy ||
              dirty ||
              !listened ||
              !ackComplete ||
              structural.length > 0 ||
              !validation ||
              reviewed
            }
            onClick={() => onConfirm(acknowledged, listened)}
          >
            {reviewed ? "Bản nháp đã được xác nhận" : "Tôi đã nghe và duyệt"}
          </Button>
          <Button
            disabled={busy || dirty || !canPublish || (!listened && !reviewed)}
            onClick={onPublish}
          >
            Xuất bản bài hát
          </Button>
        </>
      )}
    </section>
  );
}
