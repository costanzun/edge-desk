"use client";

import { ThemeProvider } from "next-themes";
import type { ReactNode } from "react";
import { DeskProvider } from "@/lib/desk-context";

export function Providers({ children }: { children: ReactNode }) {
  return (
    <ThemeProvider attribute="class" defaultTheme="light" enableSystem={false} disableTransitionOnChange>
      <DeskProvider>{children}</DeskProvider>
    </ThemeProvider>
  );
}
