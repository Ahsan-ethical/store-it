"use client";

import ArchiveShell from "@/components/archive/ArchiveShell";
import RequireAuth from "@/components/RequireAuth";
import BotSetupCard from "@/components/BotSetupCard";

export default function DashboardPage() {
  return (
    <RequireAuth>
      <>
        <BotSetupCard />
        <ArchiveShell />
      </>
    </RequireAuth>
  );
}
