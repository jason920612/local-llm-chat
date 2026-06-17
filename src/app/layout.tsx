import type { Metadata, Viewport } from "next";
import { ChunkLoadRecovery } from "@/components/ChunkLoadRecovery";
import "./globals.css";

export const metadata: Metadata = {
  title: "Local LLM Chat",
  description:
    "Private, local multimodal chat — vision, RAG and voice powered by LM Studio / llama.cpp.",
};

export const viewport: Viewport = {
  width: "device-width",
  initialScale: 1,
  // Fill the notch area; we pad with env(safe-area-inset-*) where needed.
  viewportFit: "cover",
};

export default function RootLayout({
  children,
}: Readonly<{ children: React.ReactNode }>) {
  return (
    <html lang="zh-Hant">
      <body>
        <ChunkLoadRecovery />
        {children}
      </body>
    </html>
  );
}
