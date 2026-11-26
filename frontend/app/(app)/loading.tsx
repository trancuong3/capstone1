import { Skeleton } from "@/components/common/skeleton";
import { translateMessage } from "@/lib/i18n/formatter";
import { getServerI18n } from "@/lib/i18n/server";
import { viMessages } from "@/messages/vi";

export default async function ParentAppLoading() {
  const { locale, messages } = await getServerI18n();
  const loadingText = translateMessage(
    messages,
    viMessages,
    locale,
    "accessibility.loadingContent",
  );

  return (
    <section
      aria-busy="true"
      aria-label={loadingText}
      className="mx-auto flex w-full max-w-[1120px] flex-col gap-5"
    >
      <span className="sr-only" role="status">
        {translateMessage(
          messages,
          viMessages,
          locale,
          "common.states.loading",
        )}
      </span>
      <div className="flex items-center justify-between gap-4">
        <Skeleton className="h-9 w-52 rounded-control" />
        <Skeleton className="h-9 w-28 rounded-control" />
      </div>
      <Skeleton className="h-44 w-full rounded-card" />
      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
        <Skeleton className="h-24 w-full rounded-card" />
        <Skeleton className="h-24 w-full rounded-card" />
        <Skeleton className="h-24 w-full rounded-card" />
      </div>
    </section>
  );
}
