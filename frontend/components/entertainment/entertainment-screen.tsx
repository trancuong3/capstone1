import Image from "next/image";
import { ArrowRight, Music2 } from "lucide-react";

import { ButtonLink } from "@/components/common/button";
import { ToyCannon } from "@/components/entertainment/sentence-shooter/toy-cannon";

export function EntertainmentScreen() {
  return (
    <section className="activity-library mx-auto flex w-full max-w-[1120px] flex-col gap-4">
      <header>
        <h1 className="book-title border-b border-border pb-5 text-4xl text-ink">
          Giải trí
        </h1>
      </header>
      <div className="grid items-stretch gap-4 md:grid-cols-2">
        <article className="flex flex-col gap-4 rounded-card border border-border bg-white p-6 sm:p-8">
          <div
            aria-hidden="true"
            className="flex min-h-52 flex-col items-center justify-center gap-5 rounded-card bg-sky p-6"
          >
            <div className="flex flex-wrap justify-center gap-2">
              {["Bé", "đang", "đọc", "sách."].map((word) => (
                <span
                  className="rounded-control bg-white px-4 py-2 text-xl font-extrabold text-ink"
                  key={word}
                >
                  {word}
                </span>
              ))}
            </div>
            <ToyCannon className="size-24" />
          </div>
          <h2 className="text-2xl font-extrabold text-ink">Xạ thủ ghép câu</h2>
          <p className="text-body leading-6 text-muted">
            Chọn từ trong sách và ghép lại thành câu theo đúng thứ tự.
          </p>
          <ButtonLink
            href="/entertainment/sentence-shooter"
            size="compact"
            className="mt-auto"
          >
            Bắt đầu chơi <ArrowRight aria-hidden="true" className="size-4" />
          </ButtonLink>
        </article>
        <article className="flex flex-col gap-4 rounded-card border border-border bg-white p-6 sm:p-8">
          <div className="relative min-h-52 overflow-hidden rounded-card bg-cream">
            <Image
              alt="Khu vườn đầy nắng để bé quan sát và kể chuyện"
              className="object-cover"
              fill
              sizes="(max-width: 767px) 100vw, 480px"
              src="/images/picture-description/sunny-garden.jpg"
            />
          </div>
          <h2 className="text-2xl font-extrabold text-ink">
            Kể chuyện qua tranh
          </h2>
          <p className="text-body leading-6 text-muted">
            Quan sát tranh trong sách hoặc ảnh ba mẹ tải lên. Bé có thể kể bằng
            giọng nói hoặc câu văn để nhận gợi ý từ vựng.
          </p>
          <ButtonLink
            href="/entertainment/picture-description"
            size="compact"
            className="mt-auto"
          >
            Chọn tranh <ArrowRight aria-hidden="true" className="size-4" />
          </ButtonLink>
        </article>
      </div>
      <article className="flex flex-col items-start gap-4 rounded-card border border-border bg-cream p-6 sm:flex-row sm:items-center sm:p-8">
        <div
          aria-hidden="true"
          className="grid size-16 shrink-0 place-items-center rounded-control bg-white text-primary"
        >
          <Music2 className="size-8" />
        </div>
        <div className="min-w-0 flex-1">
          <h2 className="text-2xl font-extrabold text-ink">Hát vui cùng bé</h2>
          <p className="mt-2 text-body text-muted">
            Chọn bài hát yêu thích, nghe nhạc và cùng bé hát theo lời trên màn
            hình.
          </p>
        </div>
        <ButtonLink href="/karaoke" size="compact" className="w-full sm:w-auto">
          Mở thư viện bài hát{" "}
          <ArrowRight aria-hidden="true" className="size-4" />
        </ButtonLink>
      </article>
    </section>
  );
}
