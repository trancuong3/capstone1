import { BookOpen } from "lucide-react";
import Link from "next/link";

export function BrandHeader() {
  return (
    <header className="flex min-h-11 w-full max-w-[1376px] items-center sm:h-16">
      <Link
        aria-label="ViRead - trang đăng nhập"
        className="inline-flex min-h-11 items-center gap-2 rounded-md text-label font-extrabold tracking-tight text-primary focus-visible:outline-3 focus-visible:outline-offset-3 focus-visible:outline-primary sm:text-body"
        href="/login"
      >
        <span className="grid size-9 place-items-center rounded-xl bg-sky">
          <BookOpen aria-hidden="true" className="size-5" />
        </span>
        ViRead
      </Link>
    </header>
  );
}
