import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "Local LLM Chat",
  description:
    "Private, local multimodal chat — vision, RAG and voice powered by LM Studio / llama.cpp.",
};

export default function RootLayout({
  children,
}: Readonly<{ children: React.ReactNode }>) {
  return (
    <html lang="zh-Hant">
      <body>{children}</body>
    </html>
  );
}
