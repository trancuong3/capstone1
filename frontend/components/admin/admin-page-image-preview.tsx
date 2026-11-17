"use client";

import Image from "next/image";
import { useEffect, useRef, useState } from "react";
import { Button } from "@/components/common/button";
import { useAdminServices } from "@/hooks/use-admin-services";
import type { AdminPageImageUI } from "@/types/admin";

interface AdminPageImagePreviewProps {
  readonly pageId: string;
  readonly revisionId: string;
  readonly pageNumber: number;
  readonly onReplaced?: () => void;
}

export function AdminPageImagePreview(props: AdminPageImagePreviewProps) {
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
          ? `Ẩn ảnh trang ${props.pageNumber}`
          : `Xem ảnh / thay ảnh trang ${props.pageNumber}`}
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
      setNotice("Chọn ảnh JPEG, PNG hoặc WebP, dung lượng không quá 12 MB.");
      return;
    }
    setBusy(true);
    setNotice(null);
    try {
      const result = await pages.replaceImageAndReprocess(pageId, file);
      if (!mountedRef.current) return;
      if (result.page_id !== pageId)
        throw new Error("Replacement belongs to another page");
      setNotice(
        "Ảnh mới đang chờ duyệt. Ảnh và nội dung đã xác minh vẫn được giữ cho lượt đọc.",
      );
      setFile(null);
      onReplaced?.();
    } catch {
      if (mountedRef.current)
        setNotice(
          "Chưa thay được ảnh. Mình vẫn giữ ảnh cũ; hãy thử lại với ảnh đã chọn.",
        );
    } finally {
      if (mountedRef.current) setBusy(false);
    }
  }

  const preview =
    state === "error" ? (
      <div className="rounded-control bg-surface p-3 text-sm text-muted">
        <p>Chưa tải được ảnh trang {pageNumber}.</p>
        <Button
          className="mt-2 sm:w-auto"
          variant="secondary"
          onClick={() => {
            setState("loading");
            setRequestKey((key) => key + 1);
          }}
        >
          Tải lại ảnh trang {pageNumber}
        </Button>
      </div>
    ) : state === "loading" ||
      state.pageId !== pageId ||
      state.revisionId !== revisionId ? (
      <p role="status" className="text-sm text-muted">
        Đang tải ảnh trang {pageNumber}…
      </p>
    ) : (
      <div className="relative h-48 overflow-hidden rounded-control border border-border bg-surface">
        <Image
          alt={`Ảnh trang ${pageNumber}`}
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
        Chọn ảnh mới cho trang {pageNumber}
        <input
          aria-label={`Chọn ảnh mới cho trang ${pageNumber}`}
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
        Thay ảnh trang {pageNumber}
      </Button>
      {notice ? (
        <p role="status" className="text-sm text-muted">
          {notice}
        </p>
      ) : null}
    </div>
  );
}
