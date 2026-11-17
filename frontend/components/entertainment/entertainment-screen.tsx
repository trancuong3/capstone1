import Image from "next/image";
import { ArrowRight, BookOpenText, Camera, Mic, Music2 } from "lucide-react";
import Link from "next/link";

import { ToyCannon } from "@/components/entertainment/sentence-shooter/toy-cannon";

export function EntertainmentScreen() {
  return (
    <section className="mx-auto flex w-full max-w-[1120px] flex-col gap-4">
      <header>
        <p className="text-label font-bold text-primary">Góc vui học ViRead</p>
        <h1 className="mt-1 text-heading font-extrabold text-ink">Giải trí</h1>
        <p className="mt-2 text-body text-muted">
          Chơi vui một chút, luyện đọc thêm nhiều điều hay.
        </p>
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
            Bắn các từ và sắp xếp chúng để tạo thành câu hoàn chỉnh. Chọn sách
            bé yêu thích rồi cùng khám phá nhé!
          </p>
          <p className="flex items-center gap-2 text-label text-muted">
            <BookOpenText aria-hidden="true" className="size-4 text-primary" />{" "}
            Luyện sắp xếp từ · Nhận sao sau mỗi câu
          </p>
          <Link
            className="mt-auto inline-flex min-h-12 items-center justify-center gap-2 rounded-control bg-primary px-4 font-bold text-white hover:bg-primary-hover focus-visible:outline-3 focus-visible:outline-offset-3 focus-visible:outline-primary"
            href="/entertainment/sentence-shooter"
          >
            Bắt đầu chơi <ArrowRight aria-hidden="true" className="size-4" />
          </Link>
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
          <div className="flex flex-wrap gap-3 text-label text-muted">
            <span className="inline-flex items-center gap-2">
              <Mic aria-hidden="true" className="size-4 text-primary" /> Nói
              hoặc gõ câu mô tả
            </span>
            <span className="inline-flex items-center gap-2">
              <Camera aria-hidden="true" className="size-4 text-primary" /> Chọn
              tranh sách hoặc tải ảnh
            </span>
          </div>
          <Link
            className="mt-auto inline-flex min-h-12 items-center justify-center gap-2 rounded-control bg-primary px-4 font-bold text-white hover:bg-primary-hover focus-visible:outline-3 focus-visible:outline-offset-3 focus-visible:outline-primary"
            href="/entertainment/picture-description"
          >
            Khám phá ngay <ArrowRight aria-hidden="true" className="size-4" />
          </Link>
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
        <Link
          className="inline-flex min-h-12 w-full items-center justify-center gap-2 rounded-control bg-primary px-5 font-bold text-white hover:bg-primary-hover focus-visible:outline-3 focus-visible:outline-offset-3 focus-visible:outline-primary sm:w-auto"
          href="/karaoke"
        >
          Mở thư viện bài hát{" "}
          <ArrowRight aria-hidden="true" className="size-4" />
        </Link>
      </article>
      <p className="text-label text-muted">
        Mỗi lượt chơi dùng các câu đã xác minh trong sách của ViRead.
      </p>
    </section>
  );
}
