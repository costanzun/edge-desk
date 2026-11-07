import type { Metadata } from "next";
import { LatencyView } from "@/components/views/latency-view";

export const metadata: Metadata = { title: "Latency" };

export default function Page() {
  return <LatencyView />;
}
