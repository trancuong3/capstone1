import type { Metadata } from "next";

import { ChildrenListScreen } from "@/components/children/children-list-screen";

export const metadata: Metadata = {
  title: "Hồ sơ bé",
};

export default function ChildrenPage() {
  return <ChildrenListScreen />;
}
