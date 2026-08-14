import type { Metadata } from "next";
import AcceptInvitation from "./AcceptInvitation";

export const metadata: Metadata = {
  title: "教室招待の承諾 | Ledger Lines",
  referrer: "no-referrer",
};

export default function AcceptInvitationPage() {
  return <AcceptInvitation />;
}
