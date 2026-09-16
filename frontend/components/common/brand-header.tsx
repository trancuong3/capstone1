import Link from "next/link";

export function BrandHeader() {
  return (
    <header className="flex min-h-11 w-full max-w-[1376px] items-center sm:h-16">
      <Link
        className="inline-flex min-h-11 items-center rounded-md text-label font-bold text-primary focus-visible:outline-3 focus-visible:outline-offset-3 focus-visible:outline-primary sm:text-body"
        href="/login"
      >
        READALONG VISION
      </Link>
    </header>
  );
}
