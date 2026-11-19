import { KaraokeWorkspaceScreen } from "@/components/admin/karaoke/karaoke-workspace-screen";

export default async function Page({
  searchParams,
}: {
  searchParams: Promise<{ mode?: string | string[] }>;
}) {
  const { mode } = await searchParams;
  return <KaraokeWorkspaceScreen key="new" advanced={mode === "advanced"} />;
}
