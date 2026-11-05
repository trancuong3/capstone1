import type { Metadata } from "next";

import { HelpSupportScreen } from "@/components/support/help-support-screen";

export const metadata: Metadata = {
  title: "Trợ giúp & hỗ trợ",
};

export default function HelpSupportPage() {
  return <HelpSupportScreen />;
}
