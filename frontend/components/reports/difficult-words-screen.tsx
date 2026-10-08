"use client";

import { ArrowLeft, RefreshCw, Volume2 } from "lucide-react";
import { useEffect, useState } from "react";

import { Button, ButtonLink } from "@/components/common/button";
import { EmptyState } from "@/components/common/empty-state";
import { Skeleton } from "@/components/common/skeleton";
import { StatusMessage } from "@/components/common/status-message";
import { ChildSelector } from "@/components/reports/child-selector";
import { DifficultWordItem } from "@/components/reports/difficult-word-item";
import { ReportPageHeader } from "@/components/reports/report-page-header";
import { useReportServices } from "@/hooks/use-report-services";
import { isServiceError } from "@/lib/api/service-error";
import {
  createCalendarWindow,
  currentDateInReportTimezone,
  DIFFICULT_WORD_DEFAULT_DAYS,
} from "@/lib/utils/report-state";
import type { ChildProfileDTO } from "@/types/child";
import type { DifficultWordDTO } from "@/types/reports";

type WordsState =
  | { readonly status: "loading" }
  | {
      readonly status: "ready";
      readonly children: readonly ChildProfileDTO[];
      readonly child: ChildProfileDTO;
      readonly words: readonly DifficultWordDTO[];
    }
  | { readonly status: "no-children" }
  | { readonly status: "not-found" }
  | { readonly status: "unavailable" }
  | { readonly status: "error" };

export function DifficultWordsScreen({
  requestedChildId,
}: {
  readonly requestedChildId?: string;
}) {
  const { childService, difficultWordService } = useReportServices();
  const [requestKey, setRequestKey] = useState(0);
  const [state, setState] = useState<WordsState>({ status: "loading" });

  useEffect(() => {
    let active = true;
    async function load(): Promise<void> {
      setState({ status: "loading" });
      try {
        const children = await childService.list();
        if (children.length === 0) {
          if (active) setState({ status: "no-children" });
          return;
        }
        const child = requestedChildId
          ? await childService.get(requestedChildId)
          : children[0];
        const words = await difficultWordService.list(
          child.id,
          createCalendarWindow(
            currentDateInReportTimezone(),
            DIFFICULT_WORD_DEFAULT_DAYS,
          ),
        );
        if (active) setState({ status: "ready", children, child, words });
      } catch (error) {
        if (active)
          setState({
            status:
              isServiceError(error) && error.status === 404
                ? "not-found"
                : isServiceError(error) &&
                    (error.status === 501 || error.status === 503)
                  ? "unavailable"
                  : "error",
          });
      }
    }
    void load();
    return () => {
      active = false;
    };
  }, [childService, difficultWordService, requestKey, requestedChildId]);

  if (state.status === "loading")
    return (
      <section
        aria-busy="true"
        aria-label="Đang tải từ cần luyện"
        className="mx-auto flex max-w-[1120px] flex-col gap-6"
      >
        <Skeleton className="h-32 rounded-card" />
        {[0, 1, 2].map((item) => (
          <Skeleton className="h-44 rounded-card" key={item} />
        ))}
      </section>
    );
  if (state.status === "no-children")
    return (
      <EmptyState
        headingLevel={1}
        action={<ButtonLink href="/children/new">Tạo hồ sơ bé</ButtonLink>}
        description="Tạo hồ sơ và bắt đầu đọc để hệ thống có bằng chứng."
        icon={<Volume2 aria-hidden="true" className="size-10 text-primary" />}
        title="Chưa có hồ sơ bé"
      />
    );
  if (state.status === "unavailable")
    return (
      <section className="mx-auto flex w-full max-w-[960px] flex-col gap-4">
        <h1 className="text-heading font-extrabold text-ink">
          Dữ liệu đang chờ bổ sung
        </h1>
        <StatusMessage tone="info">
          Dữ liệu của mục này chưa sẵn sàng theo định dạng hiện tại. Không có dữ
          liệu mẫu thay thế.
        </StatusMessage>
        <Button
          className="sm:w-auto sm:self-start sm:px-8"
          onClick={() => setRequestKey((key) => key + 1)}
          variant="secondary"
        >
          <RefreshCw aria-hidden="true" className="size-5" /> Thử lại
        </Button>
        <ButtonLink
          className="sm:w-auto sm:self-start"
          href="/children"
          variant="secondary"
        >
          Quản lý hồ sơ bé
        </ButtonLink>
      </section>
    );
  if (state.status === "not-found")
    return (
      <StatusMessage title="Không tìm thấy dữ liệu" tone="error">
        Dữ liệu không tồn tại hoặc không thuộc tài khoản hiện tại.
      </StatusMessage>
    );
  if (state.status === "error")
    return (
      <div className="mx-auto flex max-w-[960px] flex-col gap-4">
        <StatusMessage title="Chưa tải được từ cần luyện" tone="error">
          Có lỗi xảy ra. Ba mẹ vui lòng thử lại sau.
        </StatusMessage>
        <Button
          className="sm:w-auto sm:self-start sm:px-8"
          onClick={() => setRequestKey((key) => key + 1)}
          variant="secondary"
        >
          <RefreshCw aria-hidden="true" className="size-5" />
          Thử lại
        </Button>
      </div>
    );

  return (
    <section className="mx-auto flex w-full max-w-[1120px] flex-col gap-6 sm:gap-8">
      <ReportPageHeader
        action={
          <ButtonLink
            className="sm:w-auto"
            href={`/reports?childId=${encodeURIComponent(state.child.id)}`}
            variant="secondary"
          >
            <ArrowLeft aria-hidden="true" className="size-5" />
            Báo cáo
          </ButtonLink>
        }
        description="Bằng chứng từ báo cáo đã lưu cho kỳ 90 ngày; chỉ hiển thị dữ liệu của hồ sơ đang chọn."
        eyebrow="Cùng luyện mỗi ngày"
        title={`Từ cần luyện của ${state.child.alias}`}
      />
      <div className="max-w-md">
        <ChildSelector
          childrenProfiles={state.children}
          selectedChildId={state.child.id}
        />
      </div>
      <StatusMessage title="Nguồn dữ liệu">
        Số đếm và điểm bằng chứng lấy từ báo cáo đã lưu. Trang này không tự sinh
        bằng chứng hoặc thực hiện phát âm thanh.
      </StatusMessage>
      {state.words.length === 0 ? (
        <EmptyState
          action={
            <ButtonLink
              href={`/books?childId=${encodeURIComponent(state.child.id)}`}
            >
              Tiếp tục đọc sách
            </ButtonLink>
          }
          description="Báo cáo đã lưu chưa ghi nhận từ cần luyện trong kỳ đang chọn."
          icon={<Volume2 aria-hidden="true" className="size-10 text-primary" />}
          title="Chưa có từ cần luyện"
        />
      ) : (
        <div className="flex flex-col gap-4">
          {state.words.map((word) => (
            <DifficultWordItem
              childId={state.child.id}
              key={word.normalized_word}
              word={word}
            />
          ))}
        </div>
      )}
    </section>
  );
}
