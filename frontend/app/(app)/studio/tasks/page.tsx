import type { Metadata } from "next";

import { StudioTasksPageScreen } from "@/components/tasks/studio-tasks-page-screen";

export const metadata: Metadata = {
  title: "Trung tâm tác vụ AI — ViRead Studio",
};

export default function StudioTasksPage() {
  return <StudioTasksPageScreen viewMode="parent" />;
}
