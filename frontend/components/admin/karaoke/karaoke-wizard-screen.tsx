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
import { useI18n, useTranslations } from "@/hooks/use-i18n";
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
  const t = useTranslations("admin");
  const { formatNumber } = useI18n();
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
      if (!window.confirm(t("karaoke.wizard.leaveConfirm"))) {
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
  }, [controller, t]);
  const detail = view.detail;
  const draft = detail?.draft;
  const locked = controller.isLocked();
  const saveError = view.save?.error || view.processing?.error;
  const metaErrors = Object.fromEntries(
    (view.validation?.issues ?? []).flatMap((issue) =>
      issue.code === "SOURCE_REQUIRED"
        ? [["source_note", t("karaoke.wizard.sourceRequired")]]
        : issue.code === "USAGE_REQUIRED"
          ? [["usage_note", t("karaoke.wizard.usageRequired")]]
          : issue.code === "TITLE_REQUIRED"
            ? [["title", t("karaoke.wizard.titleRequired")]]
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
          : t("karaoke.wizard.saveDraftBeforeSwitch"),
      );
    }
  }
  function choose(kind: "audio" | "reference" | "cover", file?: File) {
    if (!file) return;
    if (
      kind === "audio" &&
      draft?.has_audio &&
      !window.confirm(t("karaoke.wizard.replaceAudioConfirm"))
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
        eyebrow={t("karaoke.wizard.eyebrow")}
        title={t("karaoke.wizard.title")}
        description={t("karaoke.wizard.description")}
        actions={
          <ButtonLink variant="quiet" href="/admin/karaoke">
            {t("karaoke.wizard.listLink")}
          </ButtonLink>
        }
      />
      <ol
        aria-label={t("karaoke.wizard.stepsAria")}
        className="grid gap-2 sm:grid-cols-3"
      >
        {[
          t("karaoke.wizard.step1"),
          t("karaoke.wizard.step2"),
          t("karaoke.wizard.step3"),
        ].map((label, index) => (
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
        ))}
      </ol>
      {detail && (
        <StatusMessage tone="info">
          {t("karaoke.wizard.draftOnServerNotice")}{" "}
          <a
            className="break-all underline"
            href={`/admin/karaoke/${detail.song_id}/edit`}
          >
            {t("karaoke.wizard.reopenSavedSong")}
          </a>
          {t("karaoke.wizard.browserFilesSuffix")}
        </StatusMessage>
      )}
      {!controller.canProcess() && (
        <StatusMessage tone="info">
          {t("karaoke.wizard.autoNotEnabledNote")}
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
                if (window.confirm(t("karaoke.wizard.reloadServerConfirm")))
                  void controller.reloadSaved();
              }}
            >
              {t("karaoke.wizard.loadSavedBtn")}
            </Button>
          )}
        </StatusMessage>
      )}
      {view.notice && (
        <StatusMessage tone="success">{view.notice}</StatusMessage>
      )}
      {detail && !draft ? (
        <Card>
          <h2 className="text-xl font-extrabold">
            {t("karaoke.wizard.publishedTitle")}
          </h2>
          <p>{t("karaoke.wizard.publishedDesc")}</p>
          <ButtonLink href="/admin/karaoke" variant="secondary">
            {t("karaoke.wizard.backToList")}
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
                  ? t("karaoke.wizard.step1SavedHeading")
                  : t("karaoke.wizard.step1NewHeading")}
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
                      ? t("karaoke.wizard.vocalSongMp3")
                      : t("karaoke.wizard.instrumentalMp3")}
                    <input
                      aria-label={
                        view.mode === "VOCAL_TRACK"
                          ? t("karaoke.wizard.vocalSongMp3")
                          : t("karaoke.wizard.instrumentalMp3")
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
                          ? t("karaoke.wizard.audioOnServer")
                          : t("karaoke.wizard.audioNotSelected"))}
                      {t("karaoke.wizard.audioLimitSuffix")}
                    </span>
                  </label>
                  <p className="text-muted">
                    {t("karaoke.wizard.vocalRecommendation")}
                  </p>
                  <label className="grid gap-2 font-bold">
                    {t("karaoke.wizard.lyricsLabel")}
                    <textarea
                      aria-label={t("karaoke.wizard.lyricsLabel")}
                      className={`${karaokeInputClass} viread-learning-content min-h-52`}
                      dir="ltr"
                      lang="vi"
                      value={view.rawLyrics}
                      maxLength={50000}
                      placeholder={t("karaoke.wizard.lyricsPlaceholder")}
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
                              t("karaoke.wizard.lyricsEditConfirm"),
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
                      {t("karaoke.wizard.lyricsInputNote")}
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
                        t("karaoke.wizard.repeatDetected", {
                          count: formatNumber(repeatProposal.markedLines),
                        })}
                      {!repeatProposal.error && (
                        <Button
                          type="button"
                          variant="secondary"
                          className="mt-3 sm:w-auto"
                          onClick={() => {
                            if (
                              window.confirm(
                                t("karaoke.wizard.repeatExpandConfirm"),
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
                          {t("karaoke.wizard.expandRepeatsBtn")}
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
                      {t("karaoke.wizard.undoExpandBtn")}
                    </Button>
                  )}
                  <details>
                    <summary className="min-h-12 cursor-pointer py-3 font-bold">
                      {t("karaoke.wizard.moreOptionsSummary")}
                    </summary>
                    <div className="grid gap-4 pt-3">
                      <label className="grid gap-2">
                        {t("karaoke.wizard.audioModeHeading")}
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
                            {t("karaoke.wizard.vocalExtractOption")}
                          </option>
                          <option value="INSTRUMENTAL_WITH_REFERENCE">
                            {t("karaoke.wizard.instrumentalWithRefOption")}
                          </option>
                        </select>
                      </label>
                      {view.mode === "INSTRUMENTAL_WITH_REFERENCE" && (
                        <label className="grid gap-2">
                          {t("karaoke.wizard.referenceAudioLabel")}
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
                                ? t("karaoke.wizard.refOnServer")
                                : t("karaoke.wizard.refNotSelected"))}
                            {t("karaoke.wizard.refMatchNote")}
                          </span>
                        </label>
                      )}
                      <label className="grid gap-2">
                        {t("karaoke.wizard.coverOptionalLabel")}
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
                            t("karaoke.wizard.coverLimitNote")}
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
                      (detail
                        ? t("karaoke.wizard.submitRecreate")
                        : t("karaoke.wizard.submitCreate"))}
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
                    {t("karaoke.wizard.advancedEditLink")}
                  </Button>
                </div>
                <p
                  role="status"
                  aria-live="polite"
                  className="text-sm text-muted"
                >
                  {view.busy ||
                    (view.save?.state === "saving"
                      ? t("karaoke.wizard.statusAutosaving")
                      : view.save?.state === "saved"
                        ? t("karaoke.wizard.statusDraftSaved")
                        : view.save?.dirty
                          ? t("karaoke.wizard.statusDirty")
                          : t("karaoke.wizard.statusDraftOnCreate"))}
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
              {t("karaoke.wizard.reviewSavedHeading")}
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
                  if (window.confirm(t("karaoke.wizard.publishConfirm")))
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
