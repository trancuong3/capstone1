import type { Metadata } from "next";

import { AppServicesProvider } from "@/components/providers/app-services-provider";
import { DifficultWordsScreen } from "@/components/reports/difficult-words-screen";

export const metadata: Metadata = { title: "Từ cần luyện" };

export default function DifficultWordsPage() {
  return (
    <AppServicesProvider>
      <DifficultWordsScreen />
    </AppServicesProvider>
  );
}
