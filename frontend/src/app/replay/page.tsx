import type { Metadata } from "next";
import { ReplayView } from "@/components/views/replay-view";

export const metadata: Metadata = { title: "Replay" };

export default function Page() {
  return <ReplayView />;
}
