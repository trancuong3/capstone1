"use client";

import { ArrowLeft, RefreshCw } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { AdminLoading, AdminPageHeader } from "@/components/admin/admin-ui";
import {
  KaraokeConfirmModal,
  type KaraokeConfirmRequest,
} from "@/components/admin/karaoke/karaoke-confirm-modal";
import { LyricTimingEditor } from "@/components/admin/karaoke/lyric-timing-editor";
import { SongMediaUpload } from "@/components/admin/karaoke/song-media-upload";
import { SongMetadataForm } from "@/components/admin/karaoke/song-metadata-form";
import { Button, ButtonLink } from "@/components/common/button";
import { Card } from "@/components/common/card";
import { StatusMessage } from "@/components/common/status-message";
import { KaraokePlayer } from "@/components/karaoke/karaoke-player";
import { useAdminKaraoke } from "@/components/karaoke/karaoke-services-provider";
import { useI18n, useTranslations } from "@/hooks/use-i18n";
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

export function KaraokeEditorScreen({
  songId,
  simpleHref,
}: {
  songId?: string;
  simpleHref?: string;
}) {
  const service = useAdminKaraoke();
  const t = useTranslations("admin");
  const { formatNumber } = useI18n();
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
  const [confirmRequest, setConfirmRequest] =
    useState<KaraokeConfirmRequest | null>(null);
  const action = useRef<AbortController | null>(null);
  const bypassLeaveGuard = useRef(false);
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
      ? t("karaoke.editor.leaveBusyConfirm")
      : t("karaoke.editor.leaveDirtyConfirm");
    function unload(event: BeforeUnloadEvent) {
      if (bypassLeaveGuard.current) return;
      event.preventDefault();
      event.returnValue = "";
    }
    function navigate(event: MouseEvent) {
      if (
        bypassLeaveGuard.current ||
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
      event.preventDefault();
      event.stopPropagation();
      const targetHref = target.href;
      const sameOrigin = target.origin === location.origin;
      const nextPath = `${target.pathname}${target.search}${target.hash}`;
      setConfirmRequest({
        title: t(
          "karaoke.confirm.leaveTitle",
          undefined,
          "Rời khỏi trang hiện tại?",
        ),
        description: message,
        confirmLabel: t("karaoke.confirm.leaveAction", undefined, "Rời trang"),
        variant: "destructive",
        onConfirm: () => {
          bypassLeaveGuard.current = true;
          if (sameOrigin && typeof router.push === "function") {
            router.push(nextPath);
          } else {
            window.location.assign(targetHref);
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
  }, [dirty, busy, router, t]);

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
      setError(t("karaoke.editor.invalidMetadataNotice"));
      return;
    }
    if (!songId) {
      void run(
        t("karaoke.editor.creatingDraft"),
        (signal) => service.create(parsed.data, signal),
        (data) => {
          adopt(data);
          router.replace(`/admin/karaoke/${data.song_id}/edit`);
        },
      );
    } else if (detail && draft && !conflict) {
      void run(
        t("karaoke.editor.savingDraft"),
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
          setNotice(t("karaoke.editor.savedDraftNotice"));
        },
      );
    }
  }
  function executeReload() {
    if (!songId) return;
    void run(
      t("karaoke.editor.reloading"),
      (signal) => service.get(songId, signal),
      adopt,
    );
  }
  function reload() {
    if (!songId) return;
    if (dirty) {
      setConfirmRequest({
        title: t(
          "karaoke.confirm.reloadTitle",
          undefined,
          "Tải lại bản từ máy chủ?",
        ),
        description: t("karaoke.editor.reloadConfirm"),
        confirmLabel: t(
          "karaoke.confirm.reloadAction",
          undefined,
          "Tải lại bản lưu",
        ),
        variant: "destructive",
        onConfirm: executeReload,
      });
      return;
    }
    executeReload();
  }
  function loadPreview() {
    if (!songId || !detail || !draft || dirty || conflict) return;
    // Removing the old player immediately stops audio and invalidates prior review.
    setPreview(null);
    setReviewed(false);
    void run(
      t("karaoke.editor.loadingPreview"),
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
  if (loading) return <AdminLoading label={t("karaoke.editor.loadingSong")} />;
  return (
    <div className="grid gap-5">
      <AdminPageHeader
        eyebrow={t("karaoke.editor.eyebrow")}
        title={
          songId
            ? t("karaoke.editor.editTitle")
            : t("karaoke.editor.createTitle")
        }
        description={t("karaoke.editor.description")}
        actions={
          <ButtonLink
            fullWidth={false}
            href="/admin/karaoke"
            size="admin"
            variant="outline"
          >
            <ArrowLeft aria-hidden className="size-4 viread-rtl-flip" />
            {t("karaoke.editor.backToSongs")}
          </ButtonLink>
        }
      />
      {error && <StatusMessage tone="error">{error}</StatusMessage>}
      {simpleHref && (
        <div>
          <ButtonLink
            fullWidth={false}
            href={detail ? `/admin/karaoke/${detail.song_id}/edit` : simpleHref}
            size="admin"
            variant="outline"
          >
            {t("karaoke.editor.backToWizard")}
          </ButtonLink>
        </div>
      )}
      {detail?.processing_review?.required &&
        !detail.processing_review.reviewed && (
          <StatusMessage tone="info">
            {t("karaoke.editor.pendingProcessingBanner")}
          </StatusMessage>
        )}
      {conflict && (
        <StatusMessage tone="warning">
          Nội dung bài hát vừa được cập nhật ở phiên làm việc khác. Vui lòng tải
          lại bản mới nhất trước khi lưu.
        </StatusMessage>
      )}
      {notice && <StatusMessage tone="success">{notice}</StatusMessage>}
      {busy && (
        <p role="status" className="text-sm font-bold text-ink">
          {busy}
          {t("karaoke.editor.busyKeepOpenSuffix")}
        </p>
      )}
      {songId && (
        <div className="flex flex-wrap items-center gap-3">
          <Button
            disabled={!!busy}
            fullWidth={false}
            onClick={reload}
            size="admin"
            variant="outline"
          >
            <RefreshCw aria-hidden className="size-4" />
            {t("karaoke.editor.reloadFromServer")}
          </Button>
          {detail && (
            <p className="text-sm text-muted">
              {t("karaoke.editor.revisionMeta", {
                state: dirty
                  ? t("karaoke.editor.stateDirty")
                  : t("karaoke.editor.stateSynced"),
              })}
            </p>
          )}
        </div>
      )}
      {songId && !detail ? (
        <StatusMessage>{t("karaoke.editor.songNotLoaded")}</StatusMessage>
      ) : detail && !draft ? (
        <Card className="bg-white p-5">
          <h2 className="text-lg font-extrabold text-ink" dir="auto">
            {detail.published?.title}
          </h2>
          <p className="text-sm text-muted">
            {t("karaoke.editor.publishedReadonlyBanner")}
          </p>
          <div>
            <Button
              disabled={disabled}
              fullWidth={false}
              onClick={() =>
                void run(
                  t("karaoke.editor.creatingRevision"),
                  (signal) =>
                    service.createDraft(
                      detail.song_id,
                      detail.revision,
                      signal,
                    ),
                  adopt,
                )
              }
              size="admin"
            >
              {t("karaoke.editor.createDraftFromPublished")}
            </Button>
          </div>
        </Card>
      ) : (
        <>
          <Card className="bg-white p-5">
            <h2 className="text-lg font-extrabold text-ink">
              {t("karaoke.editor.section1Heading")}
            </h2>
            <fieldset disabled={disabled}>
              <legend className="sr-only">
                {t("karaoke.editor.section1Legend")}
              </legend>
              <SongMetadataForm
                value={metadata}
                onChange={(value) => {
                  setMetadata(value);
                  changed();
                }}
              />
            </fieldset>
            <div>
              <Button
                disabled={disabled}
                fullWidth={false}
                onClick={save}
                size="admin"
              >
                {songId
                  ? t("karaoke.editor.saveDraftBtn")
                  : t("karaoke.editor.createDraftBtn")}
              </Button>
            </div>
          </Card>
          {draft && detail && (
            <>
              <Card className="bg-white p-5">
                <h2 className="text-lg font-extrabold text-ink">
                  {t("karaoke.editor.section2Heading")}
                </h2>
                <SongMediaUpload
                  draft={draft}
                  disabled={disabled || dirty}
                  onUpload={(kind, file) => {
                    setPreview(null);
                    void run(
                      kind === "audio"
                        ? t("karaoke.editor.uploadingAudio")
                        : t("karaoke.editor.uploadingCover"),
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
                            ? t("karaoke.editor.uploadedAudioNotice")
                            : t("karaoke.editor.uploadedCoverNotice"),
                        );
                      },
                    );
                  }}
                />
              </Card>
              <Card className="bg-white p-5">
                <h2 className="text-lg font-extrabold text-ink">
                  {t("karaoke.editor.section3Heading")}
                </h2>
                <p className="text-sm text-muted">
                  {t("karaoke.editor.section3Desc")}
                </p>
                <div>
                  <Button
                    disabled={disabled || dirty || !draft.has_audio}
                    fullWidth={false}
                    onClick={loadPreview}
                    size="admin"
                    variant="secondary"
                  >
                    {preview
                      ? t("karaoke.editor.reloadPreviewBtn")
                      : t("karaoke.editor.loadPreviewBtn")}
                  </Button>
                </div>
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
                <div>
                  <Button
                    disabled={disabled}
                    fullWidth={false}
                    onClick={save}
                    size="admin"
                  >
                    {t("karaoke.editor.saveLyricsTimingBtn")}
                  </Button>
                </div>
              </Card>
              <Card className="bg-white p-5">
                <h2 className="text-lg font-extrabold text-ink">
                  {t("karaoke.editor.section4Heading")}
                </h2>
                <p className="text-sm text-muted">
                  {t("karaoke.editor.section4Desc")}
                </p>
                <div className="flex flex-wrap items-center gap-2.5">
                  <Button
                    disabled={disabled || dirty}
                    fullWidth={false}
                    onClick={() =>
                      void run(
                        t("karaoke.editor.validatingPublish"),
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
                    size="admin"
                    variant="secondary"
                  >
                    {t("karaoke.editor.validatePublishBtn")}
                  </Button>
                  <Button
                    disabled={!canPublish}
                    fullWidth={false}
                    onClick={() =>
                      setConfirmRequest({
                        title: t(
                          "karaoke.confirm.publishTitle",
                          undefined,
                          "Xuất bản bài hát?",
                        ),
                        description: t("karaoke.editor.publishConfirm"),
                        confirmLabel: t(
                          "karaoke.confirm.publishAction",
                          undefined,
                          "Xác nhận xuất bản",
                        ),
                        variant: "primary",
                        onConfirm: () =>
                          void run(
                            t("karaoke.editor.publishing"),
                            (signal) =>
                              service.publish(
                                detail.song_id,
                                detail.revision,
                                draft.id,
                                signal,
                              ),
                            (data) => {
                              adopt(data);
                              setNotice(t("karaoke.editor.publishedNotice"));
                            },
                          ),
                      })
                    }
                    size="admin"
                  >
                    {t("karaoke.editor.publishBtn")}
                  </Button>
                </div>
                {validation && (
                  <StatusMessage
                    tone={validation.valid ? "success" : "warning"}
                    title={
                      validation.valid
                        ? t("karaoke.editor.draftValidTitle")
                        : t("karaoke.editor.draftInvalidTitle")
                    }
                  >
                    {validation.valid ? (
                      t("karaoke.editor.readyToPublishDesc")
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
                                  className="min-h-10 text-start underline"
                                  onClick={() =>
                                    setFocusTarget({
                                      lineId: issue.line_id!,
                                      syllableId:
                                        issue.syllable_id ?? undefined,
                                      request: (focusTarget?.request ?? 0) + 1,
                                    })
                                  }
                                >
                                  {t(`karaoke.editor.reasons.${issue.code}`)}
                                  {index >= 0
                                    ? t("karaoke.editor.linePrefix", {
                                        num: formatNumber(index + 1),
                                      })
                                    : ""}
                                </button>
                              ) : (
                                t(`karaoke.editor.reasons.${issue.code}`)
                              )}
                            </li>
                          );
                        })}
                      </ul>
                    )}
                  </StatusMessage>
                )}
              </Card>
            </>
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
