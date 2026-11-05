import type { Metadata } from "next";

import { AccountSettingsScreen } from "@/components/settings/account-settings-screen";

export const metadata: Metadata = {
  title: "Cài đặt tài khoản",
};

export default function SettingsPage() {
  return <AccountSettingsScreen />;
}
