"use client";

import { useCallback, useEffect, useState } from "react";
import type { Conversation, RagDocument } from "@/lib/types";
import {
  deleteConversationApi,
  fetchAppConfig,
  fetchConversations,
  fetchDocuments,
  renameConversationApi,
} from "@/lib/api";
import { Sidebar } from "./Sidebar";
import { Chat } from "./Chat";
import { DocumentsModal } from "./DocumentsModal";
import { SettingsModal } from "./SettingsModal";
import { ConfirmDialog } from "./ConfirmDialog";

/** Build the URL path for a conversation (or the root for "no conversation"). */
function pathFor(id: string | null): string {
  return id ? `/c/${encodeURIComponent(id)}` : "/";
}

/** Read the conversation id out of the current URL path, if any. */
function idFromPath(): string | null {
  const m = window.location.pathname.match(/^\/c\/([^/]+)/);
  return m ? decodeURIComponent(m[1]) : null;
}

export function AppShell({ initialId = null }: { initialId?: string | null }) {
  const [conversations, setConversations] = useState<Conversation[]>([]);
  const [activeId, setActiveId] = useState<string | null>(initialId);
  const [documents, setDocuments] = useState<RagDocument[]>([]);
  const [useRag, setUseRag] = useState(false);
  const [useGrok, setUseGrok] = useState(false);
  const [grokEnabled, setGrokEnabled] = useState(false);
  const [docsOpen, setDocsOpen] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [pendingDelete, setPendingDelete] = useState<Conversation | null>(null);
  const [sidebarOpen, setSidebarOpen] = useState(false); // mobile drawer

  // Select a conversation AND reflect it in the URL (so it's bookmarkable /
  // shareable and the back button works). Use replace on first navigation.
  const navigateTo = useCallback((id: string | null) => {
    setActiveId(id);
    if (typeof window === "undefined") return;
    if (idFromPath() === id) return; // already there
    window.history.pushState({ convId: id }, "", pathFor(id));
  }, []);

  // Keep state in sync when the user uses the browser back/forward buttons.
  useEffect(() => {
    const onPop = () => setActiveId(idFromPath());
    window.addEventListener("popstate", onPop);
    return () => window.removeEventListener("popstate", onPop);
  }, []);

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
    fetchAppConfig()
      .then((c) => {
        const enabled = c.grok?.enabled ?? false;
        setGrokEnabled(enabled);
        setUseGrok(enabled); // on by default so the model can search when needed
      })
      .catch(() => setGrokEnabled(false));
  }, [refresh, refreshDocuments]);

  // If the last document is removed, turn grounding off.
  useEffect(() => {
    if (documents.length === 0 && useRag) setUseRag(false);
  }, [documents.length, useRag]);

  const handleCreated = useCallback(
    (conv: Conversation) => {
      setConversations((prev) => [conv, ...prev]);
      navigateTo(conv.id);
    },
    [navigateTo],
  );

  const handleRename = useCallback(
    async (id: string, current: string) => {
      const next = window.prompt("Rename conversation", current);
      if (next == null || next.trim() === "" || next === current) return;
      await renameConversationApi(id, next.trim());
      await refresh();
    },
    [refresh],
  );

  // Open the custom confirm dialog instead of the browser's window.confirm.
  const handleDelete = useCallback(
    (id: string) => {
      const conv = conversations.find((c) => c.id === id) ?? null;
      if (conv) setPendingDelete(conv);
    },
    [conversations],
  );

  const confirmDelete = useCallback(async () => {
    const id = pendingDelete?.id;
    setPendingDelete(null);
    if (!id) return;
    await deleteConversationApi(id);
    if (activeId === id) navigateTo(null);
    await refresh();
  }, [pendingDelete, activeId, navigateTo, refresh]);

  const activeTitle =
    conversations.find((c) => c.id === activeId)?.title ?? null;

  return (
    <div className="flex">
      <Sidebar
        conversations={conversations}
        activeId={activeId}
        docCount={documents.length}
        open={sidebarOpen}
        onClose={() => setSidebarOpen(false)}
        onNew={() => {
          navigateTo(null);
          setSidebarOpen(false);
        }}
        onSelect={(id) => {
          navigateTo(id);
          setSidebarOpen(false);
        }}
        onRename={handleRename}
        onDelete={handleDelete}
        onOpenDocs={() => setDocsOpen(true)}
        onOpenSettings={() => setSettingsOpen(true)}
      />
      <Chat
        conversationId={activeId}
        title={activeTitle}
        onOpenSidebar={() => setSidebarOpen(true)}
        useRag={useRag}
        docCount={documents.length}
        onToggleRag={() => setUseRag((v) => !v)}
        useGrok={useGrok}
        grokEnabled={grokEnabled}
        onToggleGrok={() => setUseGrok((v) => !v)}
        onCreated={handleCreated}
        onPersisted={refresh}
      />
      <DocumentsModal
        open={docsOpen}
        onClose={() => setDocsOpen(false)}
        documents={documents}
        onChanged={refreshDocuments}
      />
      <SettingsModal
        open={settingsOpen}
        onClose={() => setSettingsOpen(false)}
      />
      <ConfirmDialog
        open={pendingDelete !== null}
        danger
        title="刪除對話"
        message={
          pendingDelete
            ? `確定要刪除「${pendingDelete.title}」嗎？此動作無法復原。`
            : undefined
        }
        confirmLabel="刪除"
        onConfirm={confirmDelete}
        onCancel={() => setPendingDelete(null)}
      />
    </div>
  );
}
