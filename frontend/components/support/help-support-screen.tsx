"use client";

import {
  CircleHelp,
  Mail,
  MessageSquareText,
  Send,
  ShieldCheck,
} from "lucide-react";
import { useEffect, useMemo, useState, type FormEvent } from "react";

import { Button } from "@/components/common/button";
import { Card } from "@/components/common/card";
import { PageHeader } from "@/components/common/page-header";
import { StatusMessage } from "@/components/common/status-message";
import { useAuthService } from "@/hooks/use-auth-service";
import {
  createSupportService,
  SupportFeedbackError,
} from "@/lib/api/support-service";
import { VIREAD_SUPPORT_EMAIL } from "@/lib/config/contact";
import type { SupportFeedbackCategory } from "@/types/support";

const categoryOptions: readonly {
  value: SupportFeedbackCategory;
  label: string;
}[] = [
  { value: "technical_issue", label: "Báo lỗi kỹ thuật" },
  { value: "feature_feedback", label: "Góp ý cải thiện tính năng" },
  { value: "account_support", label: "Yêu cầu hỗ trợ tài khoản" },
  { value: "how_to", label: "Hỏi đáp sử dụng ViRead" },
  { value: "feature_request", label: "Đề xuất tính năng mới" },
  { value: "other", label: "Khác" },
];

const faqGroups = [
  {
    title: "Tài khoản",
    items: [
      {
        question: "Làm thế nào để đổi mật khẩu?",
        answer:
          "Mở menu tài khoản, chọn Cài đặt. Với tài khoản email/mật khẩu, nhập mật khẩu hiện tại và mật khẩu mới. Với tài khoản chỉ đăng nhập bằng Google hoặc Facebook, hãy yêu cầu liên kết đặt mật khẩu qua email.",
      },
      {
        question: "Làm thế nào để cập nhật thông tin phụ huynh?",
        answer:
          "Mở menu tài khoản, chọn Hồ sơ ba mẹ. Tại đây ba mẹ có thể chỉnh sửa tên hiển thị, email hoặc số điện thoại liên hệ.",
      },
      {
        question: "Tôi không nhận được email xác nhận thì phải làm gì?",
        answer:
          "Ba mẹ kiểm tra thư rác và xác nhận địa chỉ email đã nhập. Với yêu cầu đổi email đang chờ, hãy mở Hồ sơ ba mẹ để sử dụng chức năng gửi lại email xác minh.",
      },
    ],
  },
  {
    title: "Hồ sơ trẻ",
    items: [
      {
        question: "Làm thế nào để thêm hồ sơ bé?",
        answer:
          "Mở mục Hồ sơ bé từ thanh điều hướng hoặc menu tài khoản, sau đó chọn chức năng tạo hồ sơ trẻ và nhập thông tin được yêu cầu.",
      },
      {
        question: "Làm thế nào để cập nhật thông tin của bé?",
        answer:
          "Mở Hồ sơ bé, chọn hồ sơ cần cập nhật và sử dụng chức năng chỉnh sửa đang hiển thị trên trang.",
      },
    ],
  },
  {
    title: "Sách và nhận diện",
    items: [
      {
        question: "Làm thế nào để lựa chọn sách?",
        answer:
          "Mở danh mục sách, chọn một cuốn sách đang được cung cấp trong danh mục rồi làm theo hướng dẫn trên màn hình để bắt đầu.",
      },
      {
        question: "Tôi cần làm gì khi nội dung OCR không chính xác?",
        answer:
          "Ba mẹ có thể gửi phản hồi tại trang này, ghi rõ tên sách, số trang gặp vấn đề và mô tả nội dung nhận diện chưa chính xác. Nội dung OCR cần được kiểm tra trước khi sử dụng cho hoạt động đọc.",
      },
    ],
  },
  {
    title: "Hoạt động đọc",
    items: [
      {
        question: "Làm thế nào để bắt đầu một buổi đọc?",
        answer:
          "Chọn sách trong danh mục và làm theo các bước chuẩn bị trước khi vào màn hình đọc. Hãy chọn đúng hồ sơ bé khi ứng dụng yêu cầu.",
      },
      {
        question: "Tại sao trình duyệt cần quyền microphone?",
        answer:
          "ViRead cần microphone để nhận diện lời đọc của bé trong buổi đọc. Ba mẹ cấp quyền microphone khi trình duyệt hỏi và kiểm tra thiết bị đang sử dụng.",
      },
      {
        question: "Làm thế nào để xem kết quả đọc của bé?",
        answer:
          "Mở mục Tiến bộ để xem báo cáo hoặc mục Lịch sử để xem các buổi đọc đã được lưu.",
      },
    ],
  },
] as const;

export function HelpSupportScreen() {
  const authService = useAuthService();
  const supportService = useMemo(() => createSupportService(), []);
  const [category, setCategory] =
    useState<SupportFeedbackCategory>("technical_issue");
  const [subject, setSubject] = useState("");
  const [message, setMessage] = useState("");
  const [contactEmail, setContactEmail] = useState("");
  const [hasEditedEmail, setHasEditedEmail] = useState(false);
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [successMessage, setSuccessMessage] = useState<string | null>(null);

  useEffect(() => {
    let active = true;
    void authService
      .getCurrentUser()
      .then((user) => {
        if (active && !hasEditedEmail && user?.email) {
          setContactEmail(user.email);
        }
      })
      .catch(() => {
        // Email remains editable if Auth lookup is temporarily unavailable.
      });

    return () => {
      active = false;
    };
  }, [authService, hasEditedEmail]);

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (isSubmitting) return;

    setErrorMessage(null);
    setSuccessMessage(null);

    const normalizedSubject = subject.trim();
    const normalizedMessage = message.trim();
    const normalizedEmail = contactEmail.trim().toLowerCase();

    if (!normalizedSubject || !normalizedMessage || !normalizedEmail) {
      setErrorMessage("Ba mẹ vui lòng điền tiêu đề, nội dung và email liên hệ.");
      return;
    }
    if (normalizedSubject.length > 120 || normalizedMessage.length > 5000) {
      setErrorMessage("Tiêu đề hoặc nội dung vượt quá giới hạn cho phép.");
      return;
    }
    if (
      normalizedEmail.length > 254 ||
      !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(normalizedEmail)
    ) {
      setErrorMessage("Email liên hệ chưa đúng định dạng.");
      return;
    }

    setIsSubmitting(true);
    try {
      await supportService.submitFeedback({
        category,
        subject: normalizedSubject,
        message: normalizedMessage,
        contact_email: normalizedEmail,
      });
      setSubject("");
      setMessage("");
      setSuccessMessage(
        "Máy chủ email đã tiếp nhận phản hồi của ba mẹ. ViRead sẽ sử dụng email liên hệ để phản hồi khi có thông tin cập nhật.",
      );
    } catch (error) {
      setErrorMessage(
        error instanceof SupportFeedbackError
          ? error.message
          : "Chưa gửi được phản hồi. Ba mẹ vui lòng thử lại sau.",
      );
    } finally {
      setIsSubmitting(false);
    }
  }

  return (
    <section className="mx-auto flex w-full max-w-[1040px] flex-col gap-8">
      <PageHeader
        description="ViRead luôn sẵn sàng đồng hành cùng bạn. Hãy tìm câu trả lời hoặc gửi yêu cầu hỗ trợ cho chúng tôi."
        eyebrow="Trung tâm hỗ trợ ViRead"
        title="Trợ giúp & hỗ trợ"
      />

      <section aria-labelledby="support-faq-heading" className="flex flex-col gap-4">
        <div className="flex items-center gap-3">
          <div className="flex size-11 items-center justify-center rounded-full bg-sky text-primary">
            <CircleHelp aria-hidden="true" className="size-5" />
          </div>
          <div>
            <h2 className="text-xl font-extrabold text-ink" id="support-faq-heading">
              Câu hỏi thường gặp
            </h2>
            <p className="text-sm text-muted">Một số hướng dẫn nhanh khi sử dụng ViRead.</p>
          </div>
        </div>

        {faqGroups.map((group) => (
          <Card className="gap-3" key={group.title}>
            <h3 className="text-base font-extrabold text-ink">{group.title}</h3>
            <div className="divide-y divide-border">
              {group.items.map((item) => (
                <details className="group py-3" key={item.question}>
                  <summary className="flex cursor-pointer list-none items-center justify-between gap-4 rounded-control py-2 text-left text-sm font-bold text-ink outline-none marker:hidden hover:text-primary focus-visible:ring-2 focus-visible:ring-primary [&::-webkit-details-marker]:hidden">
                    <span>{item.question}</span>
                    <span aria-hidden="true" className="shrink-0 text-lg text-primary transition-transform group-open:rotate-45">+</span>
                  </summary>
                  <p className="pb-2 pt-1 text-sm leading-6 text-muted">{item.answer}</p>
                </details>
              ))}
            </div>
          </Card>
        ))}
      </section>

      <section aria-labelledby="support-contact-heading">
        <Card>
          <div className="flex items-center gap-3">
            <div className="flex size-11 items-center justify-center rounded-full bg-sky text-primary">
              <Mail aria-hidden="true" className="size-5" />
            </div>
            <div>
              <h2 className="text-xl font-extrabold text-ink" id="support-contact-heading">
                Liên hệ chính thức
              </h2>
              <p className="text-sm text-muted">Kết nối trực tiếp với đội ngũ ViRead.</p>
            </div>
          </div>
          <p className="text-body leading-6 text-muted">
            Bạn có thể liên hệ với đội ngũ ViRead qua email để được hỗ trợ khi gặp vấn đề trong quá trình sử dụng.
          </p>
          <a
            className="inline-flex min-h-12 w-fit max-w-full items-center gap-3 rounded-control border border-border px-4 py-3 font-extrabold text-primary underline-offset-4 hover:bg-sky hover:underline focus-visible:outline-3 focus-visible:outline-offset-3 focus-visible:outline-primary"
            href={"mailto:" + VIREAD_SUPPORT_EMAIL}
          >
            <Mail aria-hidden="true" className="size-5 shrink-0" />
            <span className="break-all">{VIREAD_SUPPORT_EMAIL}</span>
          </a>
        </Card>
      </section>

      <section aria-labelledby="support-feedback-heading">
        <Card>
          <div className="flex items-center gap-3">
            <div className="flex size-11 items-center justify-center rounded-full bg-sky text-primary">
              <MessageSquareText aria-hidden="true" className="size-5" />
            </div>
            <div>
              <h2 className="text-xl font-extrabold text-ink" id="support-feedback-heading">
                Gửi phản hồi
              </h2>
              <p className="text-sm text-muted">Mô tả vấn đề hoặc đề xuất để đội ngũ ViRead tiếp nhận.</p>
            </div>
          </div>

          {successMessage ? <StatusMessage tone="success">{successMessage}</StatusMessage> : null}
          {errorMessage ? <StatusMessage tone="error">{errorMessage}</StatusMessage> : null}

          <form className="flex flex-col gap-4" noValidate onSubmit={handleSubmit}>
            <div className="flex min-h-[88px] flex-col gap-2 rounded-control border border-border bg-white px-4 py-3">
              <label className="text-label font-bold text-muted" htmlFor="support-category">
                Loại yêu cầu
              </label>
              <select
                className="min-w-0 flex-1 bg-transparent text-body text-ink outline-none focus-visible:outline-2 focus-visible:outline-primary"
                id="support-category"
                onChange={(event) => setCategory(event.target.value as SupportFeedbackCategory)}
                value={category}
              >
                {categoryOptions.map((option) => (
                  <option key={option.value} value={option.value}>{option.label}</option>
                ))}
              </select>
            </div>

            <div className="flex min-h-[88px] flex-col gap-2 rounded-control border border-border bg-white px-4 py-3">
              <label className="text-label font-bold text-muted" htmlFor="support-subject">
                Tiêu đề
              </label>
              <input
                className="min-w-0 flex-1 bg-transparent text-body text-ink outline-none focus-visible:outline-2 focus-visible:outline-primary"
                id="support-subject"
                maxLength={120}
                onChange={(event) => setSubject(event.target.value)}
                required
                value={subject}
              />
              <span className="text-right text-xs text-muted">{subject.length}/120</span>
            </div>

            <div className="flex flex-col gap-2 rounded-control border border-border bg-white px-4 py-3">
              <label className="text-label font-bold text-muted" htmlFor="support-message">
                Nội dung
              </label>
              <textarea
                className="min-h-36 resize-y bg-transparent text-body leading-6 text-ink outline-none focus-visible:outline-2 focus-visible:outline-primary"
                id="support-message"
                maxLength={5000}
                onChange={(event) => setMessage(event.target.value)}
                placeholder="Hãy mô tả vấn đề hoặc góp ý của bạn. Chúng tôi sẽ tiếp nhận và phản hồi sớm nhất có thể."
                required
                rows={6}
                value={message}
              />
              <span className="text-right text-xs text-muted">{message.length}/5000</span>
            </div>

            <div className="flex min-h-[88px] flex-col gap-2 rounded-control border border-border bg-white px-4 py-3">
              <label className="text-label font-bold text-muted" htmlFor="support-contact-email">
                Email liên hệ
              </label>
              <input
                autoComplete="email"
                className="min-w-0 flex-1 bg-transparent text-body text-ink outline-none focus-visible:outline-2 focus-visible:outline-primary"
                id="support-contact-email"
                maxLength={254}
                onChange={(event) => {
                  setHasEditedEmail(true);
                  setContactEmail(event.target.value);
                }}
                required
                type="email"
                value={contactEmail}
              />
            </div>

            <Button
              className="sm:w-auto sm:self-start sm:px-8"
              disabled={isSubmitting}
              isLoading={isSubmitting}
              type="submit"
            >
              <Send aria-hidden="true" className="size-5" />
              Gửi phản hồi
            </Button>
          </form>

          <p className="flex items-start gap-2 text-xs leading-5 text-muted">
            <ShieldCheck aria-hidden="true" className="mt-0.5 size-4 shrink-0" />
            Thông tin được sử dụng để tiếp nhận và xử lý yêu cầu hỗ trợ. Không gửi mật khẩu hoặc mã xác thực trong nội dung phản hồi.
          </p>
        </Card>
      </section>
    </section>
  );
}
