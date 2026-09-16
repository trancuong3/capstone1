import { AuthShell } from "@/components/auth/auth-shell";
import { RegisterForm } from "@/components/auth/register-form";
import { Card } from "@/components/common/card";
import { Skeleton } from "@/components/common/skeleton";
import type { AuthMockScenario } from "@/types/auth";

interface RegisterScreenProps {
  scenario: AuthMockScenario;
}

function RegisterLoadingState() {
  return (
    <AuthShell>
      <Card aria-busy="true" aria-label="Đang tải nội dung đăng ký">
        <span className="sr-only" role="status">
          Đang tải…
        </span>
        <Skeleton className="h-11 w-3/5" />
        <Skeleton className="h-7 w-4/5" />
        <Skeleton className="h-[90px] w-full sm:h-24" />
        <Skeleton className="h-[90px] w-full sm:h-24" />
        <Skeleton className="h-[90px] w-full sm:h-24" />
        <Skeleton className="h-16 w-full" />
        <Skeleton className="h-16 w-full" />
      </Card>
    </AuthShell>
  );
}

export function RegisterScreen({ scenario }: RegisterScreenProps) {
  if (scenario === "loading") {
    return <RegisterLoadingState />;
  }

  return (
    <AuthShell>
      <Card>
        <div>
          <h1 className="text-heading font-extrabold text-ink">
            <span className="sm:hidden">Đăng ký</span>
            <span className="hidden sm:inline">Tạo tài khoản cho ba mẹ</span>
          </h1>
          <p className="mt-4 text-body text-muted sm:mt-6">
            <span className="sm:hidden">
              Tạo tài khoản của ba mẹ. Bé không cần tài khoản riêng.
            </span>
            <span className="hidden sm:inline">
              Cùng bé bắt đầu hành trình đọc sách.
            </span>
          </p>
        </div>
        <RegisterForm scenario={scenario} />
      </Card>
    </AuthShell>
  );
}
