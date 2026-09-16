import "@fontsource-variable/nunito/wght.css";
import type { Metadata } from "next";
import type { ReactNode } from "react";

import "./globals.css";

export const metadata: Metadata = {
  title: {
    default: "ReadAlong Vision",
    template: "%s | ReadAlong Vision",
  },
  description: "Giao diện web responsive cho trải nghiệm đọc cùng bé.",
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
