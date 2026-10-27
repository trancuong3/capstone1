import "@fontsource-variable/nunito/wght.css";
import type { Metadata } from "next";
import type { ReactNode } from "react";

import "./globals.css";

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
      <body>{children}</body>
    </html>
  );
}
