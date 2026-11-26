"use client";

import Image from "next/image";
import { useEffect, useRef, useState } from "react";
import { Button } from "@/components/common/button";
import { useAdminServices } from "@/hooks/use-admin-services";
import { useTranslations } from "@/hooks/use-i18n";
import { isAdminOcrJobQueuedSignal } from "@/lib/api/admin-page-service";
import { clearApiReadCache } from "@/lib/api/read-cache";
import type { AdminPageImageUI } from "@/types/admin";

interface AdminPageImagePreviewProps {
  readonly pageId: string;
  readonly revisionId: string;
  readonly pageNumber: number;
  readonly onReplaced?: () => void;
}

export function AdminPageImagePreview(props: AdminPageImagePreviewProps) {
  const t = useTranslations("admin");
  const [expanded, setExpanded] = useState(false);
  const panelId = `page-image-panel-${props.pageId}`;

  return (
    <div className="grid gap-3">
      <Button
        aria-controls={panelId}
        aria-expanded={expanded}
        className="sm:w-auto sm:self-start"
        onClick={() => setExpanded((value) => !value)}
        type="button"
        variant="secondary"
      >
        {expanded
          ? t("books.imagePreview.hideButton", {
              pageNumber: props.pageNumber,
            })
          : t("books.imagePreview.showButton", {
              pageNumber: props.pageNumber,
            })}
      </Button>
      {expanded ? (
        <div id={panelId}>
          <AdminPageImagePreviewContent {...props} />
        </div>
      ) : null}
    </div>
  );
}

function AdminPageImagePreviewContent({
  pageId,
  revisionId,
  pageNumber,
  onReplaced,
}: AdminPageImagePreviewProps) {
  const { pages } = useAdminServices();
  const t = useTranslations("admin");
  const [requestKey, setRequestKey] = useState(0);
  const [file, setFile] = useState<File | null>(null);
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const mountedRef = useRef(true);
  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);
  const [state, setState] = useState<
    | { image: AdminPageImageUI; pageId: string; revisionId: string }
    | "loading"
    | "error"
  >("loading");
  useEffect(() => {
    let active = true;
    void pages.getImage(pageId, revisionId).then(
      (image) => {
        if (active) setState({ image, pageId, revisionId });
      },
      () => {
        if (active) setState("error");
      },
    );
    return () => {
      active = false;
    };
  }, [pageId, revisionId, pages, requestKey]);
  async function replaceImage() {
    if (!file || busy) return;
    if (
      !["image/jpeg", "image/png", "image/webp"].includes(file.type) ||
      file.size <= 0 ||
      file.size > 12 * 1024 * 1024
    ) {
      setNotice(t("books.imagePreview.sizeError"));
      return;
    }
    setBusy(true);
    setNotice(null);
    try {
      const result = await pages.replaceImageAndReprocess(pageId, file);
      if (!mountedRef.current) return;
      if (result.page_id !== pageId)
        throw new Error("Replacement belongs to another page");
      setNotice(t("books.imagePreview.uploadedNotice"));
      setFile(null);
      onReplaced?.();
    } catch (cause) {
      if (!mountedRef.current) return;
      if (isAdminOcrJobQueuedSignal(cause)) {
        setNotice(cause.message);
        setFile(null);
        onReplaced?.();
        return;
      }
      setNotice(t("books.imagePreview.uploadFailedNotice"));
    } finally {
      if (mountedRef.current) setBusy(false);
    }
  }

  const preview =
    state === "error" ? (
      <div className="rounded-control bg-canvas p-3 text-sm text-muted">
        <p>{t("books.imagePreview.loadError", { pageNumber })}</p>
        <Button
          className="mt-2 sm:w-auto"
          variant="secondary"
          onClick={() => {
            clearApiReadCache();
            setState("loading");
            setRequestKey((key) => key + 1);
          }}
        >
          {t("books.imagePreview.retryLoad", { pageNumber })}
        </Button>
      </div>
    ) : state === "loading" ||
      state.pageId !== pageId ||
      state.revisionId !== revisionId ? (
      <p role="status" className="text-sm text-muted">
        {t("books.imagePreview.loading", { pageNumber })}
      </p>
    ) : (
      <div className="relative h-48 overflow-hidden rounded-control border border-border bg-canvas">
        <Image
          alt={t("books.imagePreview.alt", { pageNumber })}
          src={state.image.preview_url}
          fill
          unoptimized
          sizes="(max-width: 768px) 100vw, 33vw"
          className="object-contain"
          onError={() => setState("error")}
        />
      </div>
    );
  return (
    <div className="flex flex-col gap-3">
      {preview}
      <label className="text-sm font-semibold text-ink">
        {t("books.imagePreview.chooseLabel", { pageNumber })}
        <input
          aria-label={t("books.imagePreview.chooseAria", { pageNumber })}
          accept="image/jpeg,image/png,image/webp"
          type="file"
          disabled={busy}
          className="mt-2 block min-h-11 w-full min-w-0 text-sm"
          onChange={(event) => {
            setFile(event.currentTarget.files?.[0] ?? null);
            setNotice(null);
          }}
        />
      </label>
      <Button
        className="sm:w-auto"
        variant="secondary"
        disabled={!file || busy}
        isLoading={busy}
        onClick={() => void replaceImage()}
      >
        {t("books.imagePreview.submitButton", { pageNumber })}
      </Button>
      {notice ? (
        <p role="status" className="text-sm text-muted">
          {notice}
        </p>
      ) : null}
    </div>
  );
}
