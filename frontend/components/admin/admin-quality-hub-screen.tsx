"use client";

import { BookUser, Database, Flag, RefreshCw, ShieldCheck } from "lucide-react";
import { useCallback, useRef, useState } from "react";

import { AdminBookContentQualityScreen } from "@/components/admin/admin-book-content-quality-screen";
import { AdminMetadataQualityScreen } from "@/components/admin/admin-metadata-quality-screen";
import { AdminPageHeader } from "@/components/admin/admin-ui";
import { AdminUserBooksQualitySection } from "@/components/admin/admin-user-books-quality-section";
import { Button } from "@/components/common/button";
import { useTranslations } from "@/hooks/use-i18n";
import {
  parseQualityHubTab,
  type QualityHubTab,
} from "@/lib/admin/quality-hub-tab";
import { cn } from "@/lib/utils/cn";

export { parseQualityHubTab, type QualityHubTab };

export interface AdminQualityHubScreenProps {
  readonly initialTab?: QualityHubTab;
}

const TAB_ITEMS: readonly {
  readonly id: QualityHubTab;
  readonly icon: typeof Database;
  readonly labelKey: string;
  readonly fallbackLabel: string;
}[] = [
  {
    id: "metadata",
    icon: Database,
    labelKey: "qualityHub.tabs.metadata",
    fallbackLabel: "Metadata sách",
  },
  {
    id: "reports",
    icon: Flag,
    labelKey: "qualityHub.tabs.reports",
    fallbackLabel: "Báo cáo người dùng",
  },
  {
    id: "approval",
    icon: ShieldCheck,
    labelKey: "qualityHub.tabs.approval",
    fallbackLabel: "Duyệt & An toàn sách",
  },
  {
    id: "user-books",
    icon: BookUser,
    labelKey: "qualityHub.tabs.userBooks",
    fallbackLabel: "Sách người dùng & Flow 2",
  },
];

export function AdminQualityHubScreen({
  initialTab = "metadata",
}: AdminQualityHubScreenProps) {
  const t = useTranslations("admin");
  const [prevInitialTab, setPrevInitialTab] =
    useState<QualityHubTab>(initialTab);
  const [activeTab, setActiveTab] = useState<QualityHubTab>(initialTab);
  const [refreshSignal, setRefreshSignal] = useState(0);
  const tabRefs = useRef<
    Partial<Record<QualityHubTab, HTMLButtonElement | null>>
  >({});

  if (prevInitialTab !== initialTab) {
    setPrevInitialTab(initialTab);
    setActiveTab(initialTab);
  }

  const selectTab = useCallback((nextTab: QualityHubTab) => {
    setActiveTab(nextTab);
    if (typeof window !== "undefined") {
      try {
        const url = new URL(window.location.href);
        url.searchParams.set("tab", nextTab);
        window.history.replaceState(
          null,
          "",
          `${url.pathname}${url.search}${url.hash}`,
        );
      } catch {
        // Ignore history sync errors in non-browser test environments.
      }
    }
  }, []);

  const handleTabKeyDown = useCallback(
    (event: React.KeyboardEvent<HTMLDivElement>) => {
      const currentIndex = TAB_ITEMS.findIndex((item) => item.id === activeTab);
      if (currentIndex === -1) return;

      let nextIndex: number | null = null;
      if (event.key === "ArrowRight") {
        nextIndex = (currentIndex + 1) % TAB_ITEMS.length;
      } else if (event.key === "ArrowLeft") {
        nextIndex = (currentIndex - 1 + TAB_ITEMS.length) % TAB_ITEMS.length;
      } else if (event.key === "Home") {
        nextIndex = 0;
      } else if (event.key === "End") {
        nextIndex = TAB_ITEMS.length - 1;
      }

      if (nextIndex === null) return;
      event.preventDefault();
      const target = TAB_ITEMS[nextIndex];
      selectTab(target.id);
      tabRefs.current[target.id]?.focus();
    },
    [activeTab, selectTab],
  );

  return (
    <div className="space-y-5">
      <AdminPageHeader
        actions={
          <Button
            onClick={() => setRefreshSignal((prev) => prev + 1)}
            size="admin"
            type="button"
            variant="outline"
          >
            <RefreshCw aria-hidden="true" className="size-4" />
            {t("common.reload")}
          </Button>
        }
        className="mb-4"
        description={t(
          "qualityHub.description",
          undefined,
          "Kiểm tra metadata, xử lý báo cáo phụ huynh, duyệt an toàn sách và kiểm duyệt sách người dùng trong một màn hình thống nhất.",
        )}
        eyebrow={t("qualityHub.eyebrow", undefined, "Quản trị chất lượng")}
        title={t("routes.metadataQualityTitle")}
      />

      <div
        aria-label={t(
          "qualityHub.tabsAria",
          undefined,
          "Phân khu quản lý chất lượng sách",
        )}
        className="grid grid-cols-1 gap-1.5 rounded-xl border border-border bg-surface-subtle p-1.5 sm:grid-cols-2 lg:inline-flex lg:flex-wrap lg:items-center"
        onKeyDown={handleTabKeyDown}
        role="tablist"
      >
        {TAB_ITEMS.map((tab) => {
          const Icon = tab.icon;
          const selected = activeTab === tab.id;
          return (
            <button
              aria-controls={`quality-hub-panel-${tab.id}`}
              aria-selected={selected}
              className={cn(
                "inline-flex min-h-10 items-center justify-center gap-2 rounded-control px-3.5 py-2 text-sm font-bold transition-colors focus-visible:outline-3 focus-visible:outline-offset-2 focus-visible:outline-primary lg:justify-start",
                selected
                  ? "bg-white text-primary shadow-2xs ring-1 ring-border"
                  : "text-muted hover:bg-white/75 hover:text-ink",
              )}
              id={`quality-hub-tab-${tab.id}`}
              key={tab.id}
              onClick={() => selectTab(tab.id)}
              ref={(node) => {
                tabRefs.current[tab.id] = node;
              }}
              role="tab"
              tabIndex={selected ? 0 : -1}
              type="button"
            >
              <Icon aria-hidden="true" className="size-4 shrink-0" />
              <span className="truncate">
                {t(tab.labelKey, undefined, tab.fallbackLabel)}
              </span>
            </button>
          );
        })}
      </div>

      <div
        aria-labelledby={`quality-hub-tab-${activeTab}`}
        id={`quality-hub-panel-${activeTab}`}
        role="tabpanel"
      >
        {activeTab === "metadata" ? (
          <AdminMetadataQualityScreen embedded refreshSignal={refreshSignal} />
        ) : activeTab === "reports" ? (
          <AdminBookContentQualityScreen
            embedded
            refreshSignal={refreshSignal}
            section="reports"
          />
        ) : activeTab === "approval" ? (
          <AdminBookContentQualityScreen
            embedded
            refreshSignal={refreshSignal}
            section="approval"
          />
        ) : (
          <AdminUserBooksQualitySection
            embedded
            refreshSignal={refreshSignal}
          />
        )}
      </div>
    </div>
  );
}
