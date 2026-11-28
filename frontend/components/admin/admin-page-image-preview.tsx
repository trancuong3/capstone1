"use client";

import { ImageIcon, RefreshCw, Upload } from "lucide-react";
import Image from "next/image";
import { useEffect, useRef, useState } from "react";

import { Button } from "@/components/common/button";
import { useAdminServices } from "@/hooks/use-admin-services";
import { useTranslations } from "@/hooks/use-i18n";
import { isAdminOcrJobQueuedSignal } from "@/lib/api/admin-page-service";
import { clearApiReadCache } from "@/lib/api/read-cache";
import type { AdminPageImageUI } from "@/types/admin";

export interface AdminPageImageReplacedEvent {
  readonly queued: boolean;
  readonly message?: string;
}

interface AdminPageImagePreviewProps {
  readonly pageId: string;
  readonly revisionId: string;
  readonly pageNumber: number;
  readonly onReplaced?: (event: AdminPageImageReplacedEvent) => void;
}

export function AdminPageImagePreview(props: AdminPageImagePreviewProps) {
  const t = useTranslations("admin");
  const [expanded, setExpanded] = useState(false);
  const panelId = `page-image-panel-${props.pageId}`;

  return (
    <div className="space-y-2.5">
      <Button
        aria-controls={panelId}
        aria-expanded={expanded}
        className="w-full justify-start"
        onClick={() => setExpanded((value) => !value)}
        size="admin"
        type="button"
        variant="outline"
      >
        <ImageIcon
          aria-hidden="true"
          className="size-3.5 shrink-0 text-muted"
        />
        <span className="truncate">
          {expanded
            ? t("books.imagePreview.hideButton", {
                pageNumber: props.pageNumber,
              })
            : t("books.imagePreview.showButton", {
                pageNumber: props.pageNumber,
              })}
        </span>
      </Button>
      {expanded ? (
        <div
          className="rounded-lg border border-border bg-surface-subtle/60 p-3"
          id={panelId}
        >
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
      onReplaced?.({ queued: false });
    } catch (cause) {
      if (!mountedRef.current) return;
      if (isAdminOcrJobQueuedSignal(cause)) {
        setNotice(cause.message);
        setFile(null);
        onReplaced?.({ queued: true, message: cause.message });
        return;
      }
      setNotice(t("books.imagePreview.uploadFailedNotice"));
    } finally {
      if (mountedRef.current) setBusy(false);
    }
  }

  const preview =
    state === "error" ? (
      <div className="rounded-lg border border-border bg-white p-3 text-xs text-muted">
        <p>{t("books.imagePreview.loadError", { pageNumber })}</p>
        <Button
          className="mt-2"
          onClick={() => {
            clearApiReadCache();
            setState("loading");
            setRequestKey((key) => key + 1);
          }}
          size="admin"
          variant="outline"
        >
          <RefreshCw aria-hidden="true" className="size-3.5 shrink-0" />
          {t("books.imagePreview.retryLoad", { pageNumber })}
        </Button>
      </div>
    ) : state === "loading" ||
      state.pageId !== pageId ||
      state.revisionId !== revisionId ? (
      <p className="py-4 text-center text-xs text-muted" role="status">
        {t("books.imagePreview.loading", { pageNumber })}
      </p>
    ) : (
      <div className="relative h-44 overflow-hidden rounded-lg border border-border bg-white">
        <Image
          alt={t("books.imagePreview.alt", { pageNumber })}
          className="object-contain"
          fill
          onError={() => setState("error")}
          sizes="(max-width: 768px) 100vw, 33vw"
          src={state.image.preview_url}
          unoptimized
        />
      </div>
    );

  return (
    <div className="flex flex-col gap-2.5">
      {preview}
      <label className="block text-xs font-bold text-ink">
        {t("books.imagePreview.chooseLabel", { pageNumber })}
        <input
          accept="image/jpeg,image/png,image/webp"
          aria-label={t("books.imagePreview.chooseAria", { pageNumber })}
          className="mt-1.5 block w-full min-w-0 rounded-control border border-border bg-white px-2.5 py-1.5 text-xs file:me-2 file:rounded file:border-0 file:bg-sky file:px-2 file:py-1 file:text-xs file:font-bold file:text-primary-hover"
          disabled={busy}
          onChange={(event) => {
            setFile(event.currentTarget.files?.[0] ?? null);
            setNotice(null);
          }}
          type="file"
        />
      </label>
      <Button
        className="self-start"
        disabled={!file || busy}
        isLoading={busy}
        onClick={() => void replaceImage()}
        size="admin"
        variant="secondary"
      >
        <Upload aria-hidden="true" className="size-3.5 shrink-0" />
        {t("books.imagePreview.submitButton", { pageNumber })}
      </Button>
      {notice ? (
        <p className="text-xs leading-relaxed text-muted" role="status">
          {notice}
        </p>
      ) : null}
    </div>
  );
}
