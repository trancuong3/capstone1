import { ArrowLeft, ArrowRight, Camera, Check, Mic } from "lucide-react";
import Image from "next/image";

import { BookChildHeader } from "@/components/books/book-child-header";
import { Button, ButtonLink } from "@/components/common/button";
import type { BookDetailDTO } from "@/types/book";
import type { ChildProfileDTO } from "@/types/child";
import type { DevicePermissionSnapshotUI } from "@/types/reading";

interface ReadingReadyProps {
  book: BookDetailDTO;
  child: ChildProfileDTO;
  isStarting: boolean;
  onStart: () => void;
  permissions: DevicePermissionSnapshotUI;
}

function DeviceCard({
  icon,
  label,
  ready,
}: {
  icon: "camera" | "microphone";
  label: string;
  ready: boolean;
}) {
  const Icon = icon === "camera" ? Camera : Mic;
  return (
    <div className="flex min-h-32 flex-col gap-2 rounded-card bg-white p-6">
      <p className="inline-flex items-center gap-3 text-[26px] font-bold text-ink">
        <Icon aria-hidden="true" className="size-6" />
        {label}
      </p>
      <p className="inline-flex items-center gap-2 text-body text-success-ink">
        <Check aria-hidden="true" className="size-5" />
        {ready ? `${label} đã sẵn sàng` : `${label} chưa sẵn sàng`}
      </p>
    </div>
  );
}

export function ReadingReady({
  book,
  child,
  isStarting,
  onStart,
  permissions,
}: ReadingReadyProps) {
  const detailHref = `/books/${encodeURIComponent(book.id)}?childId=${encodeURIComponent(child.id)}`;

  return (
    <section className="mx-auto flex min-h-dvh w-full max-w-[1440px] flex-col gap-4 px-4 py-4 sm:gap-6 sm:px-8 sm:py-8">
      <BookChildHeader
        backHref={detailHref}
        child={child}
        mobileLabel={`${child.alias} · ${book.title}`}
      />

      <div className="mx-auto flex w-full max-w-[744px] flex-col gap-4 sm:gap-6">
        <div className="hidden items-start gap-6 rounded-card bg-cream p-6 sm:flex">
          <Image
            alt=""
            aria-hidden="true"
            height={96}
            src="/images/figma/owl-mascot.svg"
            width={96}
          />
          <div>
            <h1 className="text-[26px] font-extrabold text-ink">
              Sẵn sàng đọc chưa nào?
            </h1>
            <p className="mt-2 text-body text-muted">
              Mình sẽ nhìn trang sách và nghe bé đọc.
            </p>
          </div>
        </div>

        <h1 className="text-heading font-extrabold text-ink sm:hidden">
          Sẵn sàng đọc chưa nào?
        </h1>

        <Image
          alt="Minh họa đặt sách trước camera"
          className="mx-auto h-auto w-full max-w-[320px]"
          height={112}
          priority
          src="/images/figma/reading-setup.svg"
          width={320}
        />

        <p className="hidden text-center text-label font-bold text-primary sm:block">
          {child.alias} · {book.title}
        </p>

        <div className="grid gap-4 sm:grid-cols-2 sm:gap-6">
          <DeviceCard
            icon="camera"
            label="Camera"
            ready={permissions.camera === "ready"}
          />
          <DeviceCard
            icon="microphone"
            label="Micro"
            ready={permissions.microphone === "ready"}
          />
        </div>

        <div className="text-left sm:text-center">
          <p className="text-body text-ink sm:text-[26px] sm:font-bold">
            Đặt sách ngay ngắn trước camera.
          </p>
          <p className="text-body text-ink sm:mt-3 sm:text-muted">
            Đọc to và tự nhiên nhé.
          </p>
        </div>

        <Button
          className="mx-auto max-w-[360px]"
          isLoading={isStarting}
          onClick={onStart}
        >
          Bắt đầu đọc
          {!isStarting ? (
            <ArrowRight aria-hidden="true" className="size-5" />
          ) : null}
        </Button>
        <div className="hidden sm:block">
          <ButtonLink
            className="mx-auto max-w-[360px]"
            href={detailHref}
            variant="quiet"
          >
            <ArrowLeft aria-hidden="true" className="size-5" />
            Quay lại chi tiết sách
          </ButtonLink>
        </div>
      </div>
    </section>
  );
}
