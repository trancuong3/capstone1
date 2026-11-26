"use client";
import { ArrowLeft, UploadCloud } from "lucide-react";
import {
  useEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
} from "react";
import { useRouter } from "next/navigation";
import { AdminPageHeader, AdminSelect } from "@/components/admin/admin-ui";
import {
  KaraokeConfirmModal,
  type KaraokeConfirmRequest,
} from "@/components/admin/karaoke/karaoke-confirm-modal";
import {
  SongMetadataForm,
  adminCompactFileInputClass,
  adminCompactTextareaClass,
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
  const [confirmRequest, setConfirmRequest] =
    useState<KaraokeConfirmRequest | null>(null);
  const [inputExpansion, setInputExpansion] = useState<{
    jobId: string | undefined;
    open: boolean;
  }>();
  const lyricConsent = useRef(false);
  const bypassLeaveGuard = useRef(false);
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
      if (controller.hasUnsaved() && !bypassLeaveGuard.current) {
        event.preventDefault();
        event.returnValue = "";
      }
    }
    function navigate(event: MouseEvent) {
      if (
        bypassLeaveGuard.current ||
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
      event.preventDefault();
      event.stopPropagation();
      const targetUrl = anchor.href;
      const sameOrigin = anchor.origin === window.location.origin;
      const nextPath = `${anchor.pathname}${anchor.search}${anchor.hash}`;
      setConfirmRequest({
        title: t(
          "karaoke.confirm.leaveTitle",
          undefined,
          "Rời khỏi trang hiện tại?",
        ),
        description: t("karaoke.wizard.leaveConfirm"),
        confirmLabel: t("karaoke.confirm.leaveAction", undefined, "Rời trang"),
        variant: "destructive",
        onConfirm: () => {
          bypassLeaveGuard.current = true;
          if (sameOrigin && typeof router.push === "function") {
            router.push(nextPath);
          } else {
            window.location.assign(targetUrl);
          }
        },
      });
    }
    window.addEventListener("beforeunload", unload);
    document.addEventListener("click", navigate, true);
    return () => {
      window.removeEventListener("beforeunload", unload);
      document.removeEventListener("click", navigate, true);
    };
  }, [controller, router, t]);

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
    if (kind === "audio" && draft?.has_audio) {
      setConfirmRequest({
        title: t(
          "karaoke.confirm.replaceAudioTitle",
          undefined,
          "Thay file nhạc MP3?",
        ),
        description: t("karaoke.wizard.replaceAudioConfirm"),
        confirmLabel: t(
          "karaoke.confirm.replaceAudioAction",
          undefined,
          "Thay nhạc",
        ),
        variant: "destructive",
        onConfirm: () => controller.chooseFile(kind, file),
      });
      return;
    }
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
    <div className="grid min-w-0 gap-5">
      <AdminPageHeader
        eyebrow={t("karaoke.wizard.eyebrow")}
        title={t("karaoke.wizard.title")}
        description={t("karaoke.wizard.description")}
        actions={
          <ButtonLink
            fullWidth={false}
            href="/admin/karaoke"
            size="admin"
            variant="outline"
          >
            <ArrowLeft aria-hidden className="size-4 viread-rtl-flip" />
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
                ? "rounded-xl bg-primary px-3.5 py-2.5 text-sm font-bold text-white"
                : "rounded-xl border border-border bg-white px-3.5 py-2.5 text-sm font-semibold text-muted"
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
              className="mt-3"
              disabled={!!view.busy || !!view.save?.busy}
              fullWidth={false}
              onClick={() =>
                setConfirmRequest({
                  title: t(
                    "karaoke.confirm.reloadTitle",
                    undefined,
                    "Tải lại bản từ máy chủ?",
                  ),
                  description: t("karaoke.wizard.reloadServerConfirm"),
                  confirmLabel: t(
                    "karaoke.confirm.reloadAction",
                    undefined,
                    "Tải lại bản lưu",
                  ),
                  variant: "destructive",
                  onConfirm: () => void controller.reloadSaved(),
                })
              }
              size="admin"
              variant="outline"
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
        <Card className="bg-white p-5">
          <h2 className="text-lg font-extrabold text-ink">
            {t("karaoke.wizard.publishedTitle")}
          </h2>
          <p className="text-sm text-muted">
            {t("karaoke.wizard.publishedDesc")}
          </p>
          <div>
            <ButtonLink
              fullWidth={false}
              href="/admin/karaoke"
              size="admin"
              variant="secondary"
            >
              {t("karaoke.wizard.backToList")}
            </ButtonLink>
          </div>
        </Card>
      ) : (
        <>
          <Card className="min-w-0 bg-white p-5">
            <details
              open={inputOpen}
              onFocusCapture={() => {
                if (hasMetaErrors)
                  setInputExpansion({ jobId: job?.id, open: true });
              }}
            >
              <summary
                className="min-h-11 cursor-pointer py-2 text-lg font-extrabold text-ink"
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
                  <div className="rounded-xl border border-dashed border-border bg-surface-subtle/50 p-4">
                    <label className="grid gap-2 text-sm font-semibold text-ink">
                      <span className="inline-flex items-center gap-2">
                        <UploadCloud
                          aria-hidden
                          className="size-4 text-primary"
                        />
                        {view.mode === "VOCAL_TRACK"
                          ? t("karaoke.wizard.vocalSongMp3")
                          : t("karaoke.wizard.instrumentalMp3")}
                      </span>
                      <input
                        aria-label={
                          view.mode === "VOCAL_TRACK"
                            ? t("karaoke.wizard.vocalSongMp3")
                            : t("karaoke.wizard.instrumentalMp3")
                        }
                        className={adminCompactFileInputClass}
                        type="file"
                        accept=".mp3,audio/mpeg"
                        onChange={(event) => {
                          choose("audio", event.target.files?.[0]);
                          event.target.value = "";
                        }}
                      />
                      <span className="break-words text-xs font-normal text-muted">
                        {view.file?.name ??
                          (draft?.has_audio
                            ? t("karaoke.wizard.audioOnServer")
                            : t("karaoke.wizard.audioNotSelected"))}
                        {t("karaoke.wizard.audioLimitSuffix")}
                      </span>
                    </label>
                  </div>
                  <p className="text-sm text-muted">
                    {t("karaoke.wizard.vocalRecommendation")}
                  </p>
                  <label className="grid gap-1.5 text-sm font-semibold text-ink">
                    {t("karaoke.wizard.lyricsLabel")}
                    <textarea
                      aria-label={t("karaoke.wizard.lyricsLabel")}
                      className={`${adminCompactTextareaClass} viread-learning-content min-h-52`}
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
                        const nextValue = event.target.value;
                        if (
                          !lyricConsent.current &&
                          view.lyrics.lines.some((line) =>
                            line.syllables?.some(
                              (s) => s.start_ms !== null || s.end_ms !== null,
                            ),
                          )
                        ) {
                          setConfirmRequest({
                            title: t(
                              "karaoke.confirm.editLyricsTitle",
                              undefined,
                              "Chỉnh sửa lời đã căn thời gian?",
                            ),
                            description: t("karaoke.wizard.lyricsEditConfirm"),
                            confirmLabel: t(
                              "karaoke.confirm.continueAction",
                              undefined,
                              "Tiếp tục",
                            ),
                            variant: "primary",
                            onConfirm: () => {
                              lyricConsent.current = true;
                              controller.setRawLyrics(nextValue);
                            },
                          });
                          return;
                        }
                        controller.setRawLyrics(nextValue);
                      }}
                    />
                    <span
                      id="karaoke-lyrics-help"
                      className="text-xs font-normal text-muted"
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
                          className="mt-3"
                          fullWidth={false}
                          onClick={() => {
                            const before = view.rawLyrics;
                            const after = repeatProposal.text;
                            setConfirmRequest({
                              title: t(
                                "karaoke.confirm.expandRepeatsTitle",
                                undefined,
                                "Mở rộng ký hiệu câu lặp?",
                              ),
                              description: t(
                                "karaoke.wizard.repeatExpandConfirm",
                              ),
                              confirmLabel: t(
                                "karaoke.confirm.expandRepeatsAction",
                                undefined,
                                "Xác nhận mở rộng",
                              ),
                              variant: "primary",
                              onConfirm: () => {
                                setRepeatUndo({ before, after });
                                controller.setRawLyrics(after);
                              },
                            });
                          }}
                          size="admin"
                          type="button"
                          variant="secondary"
                        >
                          {t("karaoke.wizard.expandRepeatsBtn")}
                        </Button>
                      )}
                    </StatusMessage>
                  )}
                  {repeatUndo && repeatUndo.after === view.rawLyrics && (
                    <div>
                      <Button
                        fullWidth={false}
                        onClick={() => {
                          controller.setRawLyrics(repeatUndo.before);
                          setRepeatUndo(undefined);
                        }}
                        size="admin"
                        type="button"
                        variant="outline"
                      >
                        {t("karaoke.wizard.undoExpandBtn")}
                      </Button>
                    </div>
                  )}
                  <details className="rounded-xl border border-border bg-surface-subtle/30 px-4 py-2">
                    <summary className="min-h-10 cursor-pointer py-2 text-sm font-bold text-ink">
                      {t("karaoke.wizard.moreOptionsSummary")}
                    </summary>
                    <div className="grid gap-4 pb-3 pt-2">
                      <AdminSelect
                        label={t("karaoke.wizard.audioModeHeading")}
                        onChange={(value) =>
                          controller.setMode(value as typeof view.mode)
                        }
                        options={[
                          {
                            value: "VOCAL_TRACK",
                            label: t("karaoke.wizard.vocalExtractOption"),
                          },
                          {
                            value: "INSTRUMENTAL_WITH_REFERENCE",
                            label: t(
                              "karaoke.wizard.instrumentalWithRefOption",
                            ),
                          },
                        ]}
                        value={view.mode}
                      />
                      {view.mode === "INSTRUMENTAL_WITH_REFERENCE" && (
                        <label className="grid gap-1.5 text-sm font-semibold text-ink">
                          {t("karaoke.wizard.referenceAudioLabel")}
                          <input
                            className={adminCompactFileInputClass}
                            type="file"
                            accept=".mp3,audio/mpeg"
                            onChange={(event) => {
                              choose("reference", event.target.files?.[0]);
                              event.target.value = "";
                            }}
                          />
                          <span className="break-words text-xs font-normal text-muted">
                            {view.reference?.name ??
                              (draft?.has_reference_audio
                                ? t("karaoke.wizard.refOnServer")
                                : t("karaoke.wizard.refNotSelected"))}
                            {t("karaoke.wizard.refMatchNote")}
                          </span>
                        </label>
                      )}
                      <label className="grid gap-1.5 text-sm font-semibold text-ink">
                        {t("karaoke.wizard.coverOptionalLabel")}
                        <input
                          className={adminCompactFileInputClass}
                          type="file"
                          accept=".jpg,.jpeg,.png,.webp"
                          onChange={(event) => {
                            choose("cover", event.target.files?.[0]);
                            event.target.value = "";
                          }}
                        />
                        <span className="text-xs font-normal text-muted">
                          {view.cover?.name ??
                            t("karaoke.wizard.coverLimitNote")}
                        </span>
                      </label>
                    </div>
                  </details>
                </fieldset>
                <div className="flex flex-wrap items-center gap-2.5">
                  <Button
                    disabled={
                      locked || !controller.canProcess() || !!view.lyricsError
                    }
                    fullWidth={false}
                    isLoading={!!view.busy}
                    onClick={() => void controller.createAndProcess()}
                    size="admin"
                  >
                    {view.busy ||
                      (detail
                        ? t("karaoke.wizard.submitRecreate")
                        : t("karaoke.wizard.submitCreate"))}
                  </Button>
                  <Button
                    disabled={
                      !!view.busy ||
                      !!view.processing?.action ||
                      !!view.save?.busy
                    }
                    fullWidth={false}
                    onClick={() => void advanced()}
                    size="admin"
                    variant="outline"
                  >
                    {t("karaoke.wizard.advancedEditLink")}
                  </Button>
                </div>
                <p
                  role="status"
                  aria-live="polite"
                  className="text-xs text-muted"
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
            <Card className="bg-white p-5">
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
            <div>
              <Button
                disabled={
                  !!view.busy ||
                  !!view.save?.busy ||
                  pendingFiles ||
                  !!view.lyricsError
                }
                fullWidth={false}
                onClick={() => void controller.loadDraftPreview()}
                size="admin"
                variant="secondary"
              >
                {t("karaoke.wizard.reviewSavedHeading")}
              </Button>
            </div>
          )}
          {view.preview && detail && (
            <Card className="min-w-0 bg-white p-5">
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
                onPublish={() =>
                  setConfirmRequest({
                    title: t(
                      "karaoke.confirm.publishTitle",
                      undefined,
                      "Xuất bản bài hát?",
                    ),
                    description: t("karaoke.wizard.publishConfirm"),
                    confirmLabel: t(
                      "karaoke.confirm.publishAction",
                      undefined,
                      "Xác nhận xuất bản",
                    ),
                    variant: "primary",
                    onConfirm: () => void controller.publish(),
                  })
                }
                canPublish={!!controller.canPublish()}
              />
            </Card>
          )}
        </>
      )}

      <KaraokeConfirmModal
        onClose={() => setConfirmRequest(null)}
        request={confirmRequest}
      />
    </div>
  );
}
