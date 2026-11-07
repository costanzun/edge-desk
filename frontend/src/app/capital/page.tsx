import type { Metadata } from "next";
import { CapitalView } from "@/components/views/capital-view";

export const metadata: Metadata = { title: "Capital" };

export default function Page() {
  return <CapitalView />;
}
