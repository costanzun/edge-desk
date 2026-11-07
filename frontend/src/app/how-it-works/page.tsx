import type { Metadata } from "next";
import { HowItWorksView } from "@/components/views/how-it-works-view";

export const metadata: Metadata = { title: "How it works" };

export default function Page() {
  return <HowItWorksView />;
}
