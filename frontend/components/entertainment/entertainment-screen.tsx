import { ArrowRight, BookOpenText, Sparkles, Star } from "lucide-react";
import Link from "next/link";

import { ToyCannon } from "@/components/entertainment/sentence-shooter/toy-cannon";

export function EntertainmentScreen() {
  return (
    <section className="mx-auto flex w-full max-w-[1130px] flex-col gap-8">
      <header className="flex flex-col gap-3">
        <p className="flex items-center gap-2 text-label font-extrabold text-primary">
          <Sparkles aria-hidden="true" className="size-5" />
          Góc vui học ViRead
        </p>
        <h1 className="text-heading font-extrabold text-ink">Giải trí</h1>
        <p className="max-w-2xl text-body text-muted">
          Chơi vui một chút, luyện đọc thêm nhiều điều hay.
        </p>
      </header>

      <article className="relative isolate overflow-hidden rounded-card border border-border bg-white shadow-[0_12px_36px_rgba(33,61,66,0.1)]">
        <div
          aria-hidden="true"
          className="pointer-events-none absolute -right-12 -top-16 -z-10 size-64 rounded-full bg-sky/70 blur-2xl"
        />
        <div className="grid items-center gap-6 p-5 sm:p-8 lg:grid-cols-[1.05fr_0.95fr] lg:gap-10 lg:p-12">
          <div className="order-2 flex flex-col items-start gap-5 lg:order-1">
            <span className="rounded-full bg-success-surface px-4 py-2 text-sm font-extrabold text-success-ink">
              Trò chơi đầu tiên
            </span>
            <div>
              <h2 className="text-2xl font-extrabold text-ink sm:text-3xl">
                Xạ thủ ghép câu
              </h2>
              <p className="mt-3 max-w-xl text-body leading-relaxed text-muted">
                Bắn các từ và sắp xếp chúng để tạo thành câu hoàn chỉnh. Chọn
                sách bé yêu thích rồi cùng khám phá nhé!
              </p>
            </div>
            <div className="flex flex-wrap items-center gap-3 text-sm font-bold text-primary">
              <span className="inline-flex items-center gap-2 rounded-full bg-sky px-3 py-2">
                <BookOpenText aria-hidden="true" className="size-4" />
                Luyện sắp xếp từ
              </span>
              <span className="inline-flex items-center gap-2 rounded-full bg-warning-surface px-3 py-2 text-warning">
                <Star aria-hidden="true" className="size-4 fill-current" />
                Nhận sao sau mỗi câu
              </span>
            </div>
            <Link
              className="inline-flex min-h-14 w-full items-center justify-center gap-2 rounded-control bg-primary px-6 text-button font-extrabold text-white transition-colors hover:bg-primary-hover focus-visible:outline-3 focus-visible:outline-offset-3 focus-visible:outline-primary sm:w-auto"
              href="/entertainment/sentence-shooter"
            >
              Bắt đầu chơi
              <ArrowRight aria-hidden="true" className="size-5" />
            </Link>
          </div>

          <div className="order-1 flex min-h-[220px] items-center justify-center overflow-hidden rounded-card bg-gradient-to-br from-[#EAF8FF] via-[#FFF7D8] to-[#F2E9FF] p-5 lg:order-2 lg:min-h-[310px]">
            <div className="relative flex w-full max-w-md flex-col items-center gap-5">
              <div className="flex flex-wrap justify-center gap-2">
                {["đọc", "Bé", "sách.", "đang"].map((word, index) => (
                  <span
                    className={
                      "rounded-full border border-white/90 px-4 py-2 text-lg font-extrabold text-ink shadow-sm " +
                      (index % 2 === 0 ? "bg-white" : "bg-[#DBF3FF]")
                    }
                    key={word}
                  >
                    {word}
                  </span>
                ))}
              </div>
              <ToyCannon className="h-28 w-28" />
              <div
                aria-hidden="true"
                className="flex items-center justify-center gap-2"
              >
                <span className="h-3 w-16 rounded-full bg-white/90" />
                <span className="h-3 w-16 rounded-full bg-white/90" />
                <span className="h-3 w-16 rounded-full bg-white/90" />
              </div>
              <Sparkles
                aria-hidden="true"
                className="absolute left-4 top-7 size-7 text-[#E7AE32]"
              />
              <Star
                aria-hidden="true"
                className="absolute right-4 top-1 size-6 fill-current text-[#F1C64D]"
              />
            </div>
          </div>
        </div>
      </article>
      <p className="text-center text-sm font-semibold text-muted">
        Mỗi lượt chơi dùng các câu đã xác minh trong sách của ViRead.
      </p>
    </section>
  );
}
