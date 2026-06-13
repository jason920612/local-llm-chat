"use client";

import { useCallback, useEffect, useState } from "react";
import type { Conversation } from "@/lib/types";
import {
  deleteConversationApi,
  fetchConversations,
  renameConversationApi,
} from "@/lib/api";
import { Sidebar } from "./Sidebar";
import { Chat } from "./Chat";

export function AppShell() {
  const [conversations, setConversations] = useState<Conversation[]>([]);
  const [activeId, setActiveId] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    try {
      setConversations(await fetchConversations());
    } catch {
      // leave existing list on transient failure
    }
  }, []);

  useEffect(() => {
    refresh();
  }, [refresh]);

  const handleCreated = useCallback((conv: Conversation) => {
    setConversations((prev) => [conv, ...prev]);
    setActiveId(conv.id);
  }, []);

  const handleRename = useCallback(
    async (id: string, current: string) => {
      const next = window.prompt("Rename conversation", current);
      if (next == null || next.trim() === "" || next === current) return;
      await renameConversationApi(id, next.trim());
      await refresh();
    },
    [refresh],
  );

  const handleDelete = useCallback(
    async (id: string) => {
      if (!window.confirm("Delete this conversation?")) return;
      await deleteConversationApi(id);
      if (activeId === id) setActiveId(null);
      await refresh();
    },
    [activeId, refresh],
  );

  const activeTitle =
    conversations.find((c) => c.id === activeId)?.title ?? null;

  return (
    <div className="flex">
      <Sidebar
        conversations={conversations}
        activeId={activeId}
        onNew={() => setActiveId(null)}
        onSelect={setActiveId}
        onRename={handleRename}
        onDelete={handleDelete}
      />
      <Chat
        conversationId={activeId}
        title={activeTitle}
        onCreated={handleCreated}
        onPersisted={refresh}
      />
    </div>
  );
}
