import type { Metadata } from "next";
import { AdminLoginScreen } from "@/components/admin/admin-login-screen";
import { AdminServicesProvider } from "@/components/providers/admin-services-provider";
import { resolveAdminAuthRuntime } from "@/lib/utils/admin-scenario";

export const metadata: Metadata = { title: "Đăng nhập quản trị" };

export default async function Page({
  searchParams,
}: {
  searchParams: Promise<{
    next?: string | string[];
    state?: string | string[];
  }>;
}) {
  const query = await searchParams;
  const { mode, scenario } = resolveAdminAuthRuntime(query.state);
  const nextPath = Array.isArray(query.next) ? query.next[0] : query.next;

  return (
    <AdminServicesProvider authMode={mode} scenario={scenario}>
      <AdminLoginScreen nextPath={nextPath ?? null} scenario={scenario} />
    </AdminServicesProvider>
  );
}
