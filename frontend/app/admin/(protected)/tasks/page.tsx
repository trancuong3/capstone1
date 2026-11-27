import type { Metadata } from "next";

import { StudioTasksPageScreen } from "@/components/tasks/studio-tasks-page-screen";

export const metadata: Metadata = {
  title: "Trung tâm tác vụ AI — Quản trị ViRead",
};

export default function AdminStudioTasksPage() {
  return <StudioTasksPageScreen viewMode="admin" />;
}
