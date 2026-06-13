"use client";

import { useCallback, useEffect, useState } from "react";
import type { Conversation, RagDocument } from "@/lib/types";
import {
  deleteConversationApi,
  fetchConversations,
  fetchDocuments,
  renameConversationApi,
} from "@/lib/api";
import { Sidebar } from "./Sidebar";
import { Chat } from "./Chat";
import { DocumentsModal } from "./DocumentsModal";

export function AppShell() {
  const [conversations, setConversations] = useState<Conversation[]>([]);
  const [activeId, setActiveId] = useState<string | null>(null);
  const [documents, setDocuments] = useState<RagDocument[]>([]);
  const [useRag, setUseRag] = useState(false);
  const [docsOpen, setDocsOpen] = useState(false);

  const refresh = useCallback(async () => {
    try {
      setConversations(await fetchConversations());
    } catch {
      /* keep existing list on transient failure */
    }
  }, []);

  const refreshDocuments = useCallback(async () => {
    try {
      setDocuments(await fetchDocuments());
    } catch {
      /* ignore */
    }
  }, []);

  useEffect(() => {
    refresh();
    refreshDocuments();
  }, [refresh, refreshDocuments]);

  // If the last document is removed, turn grounding off.
  useEffect(() => {
    if (documents.length === 0 && useRag) setUseRag(false);
  }, [documents.length, useRag]);

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
        docCount={documents.length}
        onNew={() => setActiveId(null)}
        onSelect={setActiveId}
        onRename={handleRename}
        onDelete={handleDelete}
        onOpenDocs={() => setDocsOpen(true)}
      />
      <Chat
        conversationId={activeId}
        title={activeTitle}
        useRag={useRag}
        docCount={documents.length}
        onToggleRag={() => setUseRag((v) => !v)}
        onCreated={handleCreated}
        onPersisted={refresh}
      />
      <DocumentsModal
        open={docsOpen}
        onClose={() => setDocsOpen(false)}
        documents={documents}
        onChanged={refreshDocuments}
      />
    </div>
  );
}
