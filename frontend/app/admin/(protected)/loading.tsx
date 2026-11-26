import { Skeleton } from "@/components/common/skeleton";
import { translateMessage } from "@/lib/i18n/formatter";
import { getServerI18n } from "@/lib/i18n/server";
import { viMessages } from "@/messages/vi";

export default async function ProtectedAdminLoading() {
  const { locale, messages } = await getServerI18n();
  return (
    <section
      aria-busy="true"
      aria-label={translateMessage(
        messages,
        viMessages,
        locale,
        "admin.routes.protectedLoadingAria",
      )}
      className="mx-auto flex w-full max-w-[1360px] flex-col gap-5"
    >
      <span className="sr-only" role="status">
        {translateMessage(
          messages,
          viMessages,
          locale,
          "admin.routes.protectedLoadingStatus",
        )}
      </span>
      <div className="flex flex-col gap-2">
        <Skeleton className="h-4 w-32 rounded-control" />
        <Skeleton className="h-9 w-64 rounded-control" />
      </div>
      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
        <Skeleton className="h-28 w-full rounded-card" />
        <Skeleton className="h-28 w-full rounded-card" />
        <Skeleton className="h-28 w-full rounded-card" />
      </div>
      <Skeleton className="h-64 w-full rounded-card" />
    </section>
  );
}
