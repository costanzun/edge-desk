import type { Metadata } from "next";
import { PositionsView } from "@/components/views/positions-view";

export const metadata: Metadata = { title: "Positions & P&L" };

export default function Page() {
  return <PositionsView />;
}
