import type { Metadata } from "next";

import { ParentProfileScreen } from "@/components/profile/parent-profile-screen";
import { AppServicesProvider } from "@/components/providers/app-services-provider";

export const metadata: Metadata = {
  title: "Hồ sơ ba mẹ",
};

export default function ProfilePage() {
  return (
    <AppServicesProvider>
      <ParentProfileScreen />
    </AppServicesProvider>
  );
}
