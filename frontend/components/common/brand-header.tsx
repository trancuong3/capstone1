import { ViReadLogo } from "@/components/common/viread-logo";

export function BrandHeader() {
  return (
    <header className="flex min-h-11 w-full max-w-[1376px] items-center sm:h-16">
      <ViReadLogo
        ariaLabel="ViRead - trang đăng nhập"
        href="/login"
        size="sm"
      />
    </header>
  );
}
