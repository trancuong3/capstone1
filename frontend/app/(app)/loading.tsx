import { Skeleton } from "@/components/common/skeleton";

export default function ParentAppLoading() {
  return (
    <section
      aria-busy="true"
      aria-label="Đang tải trang"
      className="mx-auto flex w-full max-w-[1120px] flex-col gap-5"
    >
      <span className="sr-only" role="status">
        Đang tải nội dung…
      </span>
      <div className="flex items-center justify-between gap-4">
        <Skeleton className="h-9 w-52 rounded-control" />
        <Skeleton className="h-9 w-28 rounded-control" />
      </div>
      <Skeleton className="h-44 w-full rounded-card" />
      <div className="grid gap-4 min-[640px]:grid-cols-2 lg:grid-cols-3">
        <Skeleton className="h-24 w-full rounded-card" />
        <Skeleton className="h-24 w-full rounded-card" />
        <Skeleton className="h-24 w-full rounded-card" />
      </div>
    </section>
  );
}
