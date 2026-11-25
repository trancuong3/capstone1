import type { Metadata } from "next";

import { ParentProfileScreen } from "@/components/profile/parent-profile-screen";

export const metadata: Metadata = {
  title: "Hồ sơ ba mẹ",
};

export default function ProfilePage() {
  return <ParentProfileScreen />;
}
