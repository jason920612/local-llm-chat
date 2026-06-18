"use client";

import { useCallback, useEffect, useRef, useState } from "react";
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
import { SkillsModal } from "./SkillsModal";
import { ControlDashboardModal } from "./ControlDashboardModal";
import { VmConsolePanel } from "./VmConsolePanel";
import { ConfirmDialog } from "./ConfirmDialog";
import { useIsMobile } from "@/lib/useIsMobile";

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
  const [skillsOpen, setSkillsOpen] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [dashboardOpen, setDashboardOpen] = useState(false);
  const [consoleOpen, setConsoleOpen] = useState(false);
  const [pendingDelete, setPendingDelete] = useState<Conversation | null>(null);
  const [sidebarOpen, setSidebarOpen] = useState(false); // mobile drawer
  // Bumped to force the global /api/events EventSource to reconnect after the
  // app returns from the background (mobile WebViews freeze the connection, so
  // conversations created/renamed/deleted meanwhile are otherwise missed).
  const [resyncTick, setResyncTick] = useState(0);
  const isMobile = useIsMobile();

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

  // Latest activeId, readable from the long-lived SSE handler below.
  const activeIdRef = useRef(activeId);
  activeIdRef.current = activeId;

  // Live multi-device sync of the conversation list: any device creating,
  // renaming, or deleting a conversation is reflected here in real time.
  useEffect(() => {
    const es = new EventSource("/api/events");
    es.onmessage = (ev) => {
      let e: {
        type: string;
        conversation?: Conversation;
        id?: string;
      };
      try {
        e = JSON.parse(ev.data);
      } catch {
        return;
      }
      if (e.type === "conv-created" && e.conversation) {
        const conv = e.conversation;
        setConversations((prev) =>
          prev.some((c) => c.id === conv.id) ? prev : [conv, ...prev],
        );
      } else if (e.type === "conv-updated" && e.conversation) {
        const conv = e.conversation;
        setConversations((prev) => {
          const next = prev.map((c) => (c.id === conv.id ? conv : c));
          // Bubble the just-updated conversation to the top (most recent).
          next.sort((a, b) => b.updatedAt - a.updatedAt);
          return next;
        });
      } else if (e.type === "conv-deleted" && e.id) {
        const goneId = e.id;
        setConversations((prev) => prev.filter((c) => c.id !== goneId));
        if (activeIdRef.current === goneId) navigateTo(null);
      }
    };
    es.onerror = () => {
      /* auto-reconnects */
    };
    return () => es.close();
  }, [navigateTo, resyncTick]);

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

  // Background → foreground resync for the conversation LIST. On mobile (and
  // backgrounded desktop tabs) the global /api/events stream is frozen while in
  // the background, so a new/renamed/deleted conversation that happened
  // meanwhile is missed and the sidebar looks stale until a full app restart.
  // When we become visible again, re-fetch the list AND bump resyncTick to
  // reopen the stream. (Chat.tsx does the same for the active conversation.)
  useEffect(() => {
    const onForeground = () => {
      if (document.visibilityState === "hidden") return;
      refresh();
      setResyncTick((t) => t + 1);
    };
    document.addEventListener("visibilitychange", onForeground);
    window.addEventListener("coderyo-resume", onForeground);
    window.addEventListener("pageshow", onForeground);
    window.addEventListener("focus", onForeground);
    return () => {
      document.removeEventListener("visibilitychange", onForeground);
      window.removeEventListener("coderyo-resume", onForeground);
      window.removeEventListener("pageshow", onForeground);
      window.removeEventListener("focus", onForeground);
    };
  }, [refresh]);

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
      setConversations((prev) =>
        prev.some((c) => c.id === conv.id) ? prev : [conv, ...prev],
      );
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

  // Until the device class is known, render a neutral shell to avoid a
  // hydration mismatch between the desktop and mobile component trees.
  if (isMobile === null) return <div className="h-dvh bg-background" />;

  return (
    <div className="flex h-dvh overflow-hidden">
      <Sidebar
        conversations={conversations}
        activeId={activeId}
        docCount={documents.length}
        isMobile={isMobile}
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
        onOpenSkills={() => setSkillsOpen(true)}
        onOpenDashboard={() => setDashboardOpen(true)}
        onOpenSettings={() => setSettingsOpen(true)}
      />
      <Chat
        conversationId={activeId}
        title={activeTitle}
        isMobile={isMobile}
        onOpenSidebar={() => setSidebarOpen(true)}
        useRag={useRag}
        docCount={documents.length}
        onToggleRag={() => setUseRag((v) => !v)}
        useGrok={useGrok}
        grokEnabled={grokEnabled}
        onToggleGrok={() => setUseGrok((v) => !v)}
        onCreated={handleCreated}
        onPersisted={refresh}
        onToggleConsole={() => setConsoleOpen((v) => !v)}
        consoleOpen={consoleOpen}
      />
      <VmConsolePanel
        open={consoleOpen}
        conversationId={activeId}
        isMobile={isMobile}
        onClose={() => setConsoleOpen(false)}
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
      <SkillsModal open={skillsOpen} onClose={() => setSkillsOpen(false)} />
      <ControlDashboardModal
        open={dashboardOpen}
        activeConversationId={activeId}
        onClose={() => setDashboardOpen(false)}
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
