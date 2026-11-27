"use client";
import { useState } from "react";
import { LyricTimingEditor } from "@/components/admin/karaoke/lyric-timing-editor";
import type { TimingFocus } from "@/components/admin/karaoke/syllable-timing-editor";
import { Button } from "@/components/common/button";
import { StatusMessage } from "@/components/common/status-message";
import { KaraokePlayer } from "@/components/karaoke/karaoke-player";
import { useTranslations } from "@/hooks/use-i18n";
import type { WizardPreview } from "@/lib/karaoke/wizard-controller";
import type {
  AdminKaraokeDetail,
  KaraokeLyrics,
  KaraokePreview,
  KaraokeValidation,
} from "@/types/karaoke";
import type { DraftReferencePreview } from "@/types/karaoke-processing";

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
  const t = useTranslations("admin");
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
        staging
          ? t("karaoke.review.stagingAria")
          : t("karaoke.review.draftAria")
      }
    >
      <h2 className="text-lg font-extrabold text-ink">
        {staging
          ? t("karaoke.review.stagingHeading")
          : t("karaoke.review.draftHeading")}
      </h2>
      <StatusMessage tone="info">
        {staging
          ? t("karaoke.review.stagingSubtitle")
          : t("karaoke.review.draftSubtitle")}
      </StatusMessage>
      <div className="flex flex-wrap items-center gap-2.5">
        <Button
          disabled={busy || !useReference}
          fullWidth={false}
          onClick={() => setUseReference(false)}
          size="admin"
          variant="secondary"
        >
          {t("karaoke.review.listenInstrumental")}
        </Button>
        {referenceUrl && referenceExpiry ? (
          <Button
            disabled={busy || useReference}
            fullWidth={false}
            onClick={() => setUseReference(true)}
            size="admin"
            variant="secondary"
          >
            {t("karaoke.review.listenReference")}
          </Button>
        ) : (
          !staging && (
            <Button
              disabled={busy || dirty}
              fullWidth={false}
              onClick={onReference}
              size="admin"
              variant="secondary"
            >
              {t("karaoke.review.loadReference")}
            </Button>
          )
        )}
        <Button
          disabled={busy || dirty}
          fullWidth={false}
          onClick={reloadSelectedSource}
          size="admin"
          variant="outline"
        >
          {useReference
            ? t("karaoke.review.refreshReference")
            : t("karaoke.review.refreshPreview")}
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
            ? t("karaoke.review.playerTitleRef")
            : staging
              ? t("karaoke.review.playerTitleStaging")
              : t("karaoke.review.playerTitleDraft")
        }
        lyrics={staging ? source.lyrics : lyrics}
        onReload={reloadSelectedSource}
      >
        {(player) => (
          <>
            {flags.length > 0 && (
              <div
                className="grid gap-3"
                aria-label={t("karaoke.review.flagsAria")}
              >
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
                      className="grid gap-2.5 rounded-xl border border-border bg-surface-subtle/40 p-4"
                    >
                      <p className="text-sm font-semibold text-ink">
                        {t(`karaoke.review.flags.${flag.message_key}`)}
                      </p>
                      {target ? (
                        <p
                          className="viread-learning-content text-sm text-muted"
                          dir="ltr"
                          lang="vi"
                        >
                          {target.text}
                        </p>
                      ) : (
                        <p className="text-sm text-muted">
                          {t("karaoke.review.staleWarningHint")}
                        </p>
                      )}
                      {!staging && target && (
                        <div>
                          <Button
                            disabled={busy}
                            fullWidth={false}
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
                            size="admin"
                            variant="outline"
                          >
                            {t("karaoke.review.inspectLineBtn")}
                          </Button>
                        </div>
                      )}
                      {!staging && (
                        <label className="flex items-start gap-2.5 text-sm">
                          <input
                            className="mt-0.5 size-4 accent-primary"
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
                          {t("karaoke.review.ackFlagCheckbox")}
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
                <summary className="min-h-11 cursor-pointer py-2 text-sm font-bold text-primary-hover">
                  {t("karaoke.review.advancedEditorLink")}
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
        <div className="flex flex-wrap items-center gap-2.5">
          <Button
            disabled={busy}
            fullWidth={false}
            onClick={onApply}
            size="admin"
          >
            {t("karaoke.review.useInDraftBtn")}
          </Button>
        </div>
      ) : (
        <>
          {structural.length > 0 && (
            <StatusMessage tone="warning">
              <p>{t("karaoke.review.mustFixHeader")}</p>
              <ul className="list-disc ps-5">
                {structural.slice(0, 15).map((issue, index) => (
                  <li key={index}>
                    {issue.code === "SOURCE_REQUIRED"
                      ? t("karaoke.review.fixSource")
                      : issue.code === "USAGE_REQUIRED"
                        ? t("karaoke.review.fixUsage")
                        : issue.code === "TITLE_REQUIRED"
                          ? t("karaoke.review.fixTitle")
                          : issue.field === "lyrics"
                            ? t("karaoke.review.fixTiming")
                            : t("karaoke.review.fixGeneric")}
                  </li>
                ))}
              </ul>
            </StatusMessage>
          )}
          <label className="flex items-start gap-2.5 text-sm">
            <input
              className="mt-0.5 size-4 accent-primary"
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
            {t("karaoke.review.reviewedAckCheckbox")}
          </label>
          <div className="flex flex-wrap items-center gap-2.5">
            <Button
              disabled={
                busy ||
                dirty ||
                !listened ||
                !ackComplete ||
                structural.length > 0 ||
                !validation ||
                reviewed
              }
              fullWidth={false}
              onClick={() => onConfirm(acknowledged, listened)}
              size="admin"
              variant="secondary"
            >
              {reviewed
                ? t("karaoke.review.draftConfirmedBtn")
                : t("karaoke.review.confirmReviewBtn")}
            </Button>
            <Button
              disabled={
                busy || dirty || !canPublish || (!listened && !reviewed)
              }
              fullWidth={false}
              onClick={onPublish}
              size="admin"
            >
              {t("karaoke.review.publishSongBtn")}
            </Button>
          </div>
        </>
      )}
    </section>
  );
}
