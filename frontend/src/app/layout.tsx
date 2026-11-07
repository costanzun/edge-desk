import type { Metadata, Viewport } from "next";
import { Doto, IBM_Plex_Mono, Inter } from "next/font/google";
import "./globals.css";
import { Providers } from "@/components/providers";
import { Shell } from "@/components/shell/shell";

const inter = Inter({ variable: "--font-inter", subsets: ["latin"] });
const doto = Doto({ variable: "--font-doto", subsets: ["latin"], axes: ["ROND"] });
const plexMono = IBM_Plex_Mono({ variable: "--font-plex-mono", subsets: ["latin"], weight: ["400", "500", "600"] });

export const metadata: Metadata = {
  title: { default: "Edge Desk", template: "%s · Edge Desk" },
  description:
    "Paper-only trading desk comparing Kalshi and Polymarket 'Bitcoin above $X' prices with Deribit options-implied probabilities: event-sourced, deterministic replay, risk engine, kill switch, latency measurement.",
};

export const viewport: Viewport = {
  themeColor: [
    { media: "(prefers-color-scheme: light)", color: "#e4e3e6" },
    { media: "(prefers-color-scheme: dark)", color: "#161719" },
  ],
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en" suppressHydrationWarning className={`${inter.variable} ${plexMono.variable} ${doto.variable}`}>
      <body className="min-h-dvh overflow-x-hidden">
        <Providers>
          <Shell>{children}</Shell>
        </Providers>
      </body>
    </html>
  );
}
