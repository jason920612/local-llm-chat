import { AppShell } from "@/components/AppShell";

/** Deep link to a specific conversation: /c/<id>. */
export default async function ConversationPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  return <AppShell initialId={id} />;
}
