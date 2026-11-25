import "@fontsource-variable/nunito/wght.css";
import type { Metadata, Viewport } from "next";
import type { ReactNode } from "react";

import { NavigationFeedbackBar } from "@/components/common/navigation-feedback";
import "./globals.css";

export const viewport: Viewport = {
  width: "device-width",
  initialScale: 1,
  viewportFit: "cover",
  themeColor: "#fffaf0",
};

export const metadata: Metadata = {
  title: {
    default: "ViRead",
    template: "%s | ViRead",
  },
  description: "Nền tảng đồng hành cùng ba mẹ và bé trên hành trình đọc sách.",
};

export default function RootLayout({
  children,
}: Readonly<{ children: ReactNode }>) {
  return (
    <html lang="vi">
      <body>
        <NavigationFeedbackBar />
        {children}
      </body>
    </html>
  );
}
