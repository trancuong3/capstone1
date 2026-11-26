import Image from "next/image";
import { ArrowRight, Music2 } from "lucide-react";

import { ButtonLink } from "@/components/common/button";
import { ToyCannon } from "@/components/entertainment/sentence-shooter/toy-cannon";

export function EntertainmentScreen() {
  return (
    <section className="activity-library mx-auto flex w-full max-w-[1120px] flex-col gap-3 md:gap-4">
      <header>
        <h1 className="book-title border-b border-border pb-2.5 text-xl text-ink md:pb-5 md:text-4xl">
          Giải trí
        </h1>
      </header>
      <div className="grid items-stretch gap-3 min-[640px]:grid-cols-2 md:gap-4">
        <article className="flex flex-col gap-3 rounded-card border border-border bg-white p-4 min-[640px]:gap-3.5 min-[640px]:p-5 md:gap-4 md:p-8">
          <div
            aria-hidden="true"
            className="flex min-h-28 flex-col items-center justify-center gap-3 rounded-card bg-sky p-3.5 min-[640px]:min-h-36 md:min-h-52 md:gap-5 md:p-6"
          >
            <div className="flex flex-wrap justify-center gap-1.5 md:gap-2">
              {["Bé", "đang", "đọc", "sách."].map((word) => (
                <span
                  className="rounded-control bg-white px-2.5 py-1 text-sm font-extrabold text-ink md:px-4 md:py-2 md:text-xl"
                  key={word}
                >
                  {word}
                </span>
              ))}
            </div>
            <ToyCannon className="size-14 md:size-24" />
          </div>
          <h2 className="text-lg font-extrabold text-ink md:text-2xl">
            Xạ thủ ghép câu
          </h2>
          <p className="text-sm leading-5 text-muted md:text-body md:leading-6">
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
        <article className="flex flex-col gap-3 rounded-card border border-border bg-white p-4 min-[640px]:gap-3.5 min-[640px]:p-5 md:gap-4 md:p-8">
          <div className="relative min-h-28 overflow-hidden rounded-card bg-cream min-[640px]:min-h-36 md:min-h-52">
            <Image
              alt="Khu vườn đầy nắng để bé quan sát và kể chuyện"
              className="object-cover"
              fill
              sizes="(max-width: 767px) 100vw, 480px"
              src="/images/picture-description/sunny-garden.jpg"
            />
          </div>
          <h2 className="text-lg font-extrabold text-ink md:text-2xl">
            Kể chuyện qua tranh
          </h2>
          <p className="text-sm leading-5 text-muted md:text-body md:leading-6">
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
      <article className="flex flex-col items-start gap-3 rounded-card border border-border bg-cream p-4 min-[640px]:flex-row min-[640px]:items-center min-[640px]:gap-4 min-[640px]:p-6 md:p-8">
        <div
          aria-hidden="true"
          className="grid size-12 shrink-0 place-items-center rounded-control bg-white text-primary md:size-16"
        >
          <Music2 className="size-6 md:size-8" />
        </div>
        <div className="min-w-0 flex-1">
          <h2 className="text-lg font-extrabold text-ink md:text-2xl">
            Hát vui cùng bé
          </h2>
          <p className="mt-1 text-sm text-muted md:mt-2 md:text-body">
            Chọn bài hát yêu thích, nghe nhạc và cùng bé hát theo lời trên màn
            hình.
          </p>
        </div>
        <ButtonLink
          href="/karaoke"
          size="compact"
          className="w-full min-[640px]:w-auto"
        >
          Mở thư viện bài hát{" "}
          <ArrowRight aria-hidden="true" className="size-4" />
        </ButtonLink>
      </article>
    </section>
  );
}
