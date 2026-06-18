"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import type { Conversation, Project, RagDocument } from "@/lib/types";
import {
  createProjectApi,
  deleteConversationApi,
  deleteConversationsBulkApi,
  deleteProjectApi,
  fetchAppConfig,
  fetchConversations,
  fetchDocuments,
  fetchProjects,
  renameConversationApi,
  updateConversationApi,
  updateProjectApi,
} from "@/lib/api";
import { Sidebar } from "./Sidebar";
import { Chat } from "./Chat";
import { DocumentsModal } from "./DocumentsModal";
import { SettingsModal } from "./SettingsModal";
import { SkillsModal } from "./SkillsModal";
import { ControlDashboardModal } from "./ControlDashboardModal";
import { VmConsolePanel } from "./VmConsolePanel";
import { ConfirmDialog } from "./ConfirmDialog";
import { ProjectSettingsModal } from "./ProjectSettingsModal";
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
  const [projects, setProjects] = useState<Project[]>([]);
  const [activeId, setActiveId] = useState<string | null>(initialId);
  const [activeProjectId, setActiveProjectId] = useState<string | null>(null);
  const [editingProject, setEditingProject] = useState<Project | null>(null);
  const [documents, setDocuments] = useState<RagDocument[]>([]);
  const [globalDocCount, setGlobalDocCount] = useState(0);
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
      } else if (
        e.type === "project-created" ||
        e.type === "project-updated" ||
        e.type === "project-deleted"
      ) {
        refreshProjects();
        refresh();
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

  const refreshProjects = useCallback(async () => {
    try {
      setProjects(await fetchProjects());
    } catch {
      /* keep existing list on transient failure */
    }
  }, []);

  const refreshDocuments = useCallback(async () => {
    try {
      const [scoped, globalDocs] = await Promise.all([
        fetchDocuments(activeProjectId),
        activeProjectId ? fetchDocuments(null) : Promise.resolve([]),
      ]);
      setDocuments(scoped);
      setGlobalDocCount(globalDocs.length);
    } catch {
      /* ignore */
    }
  }, [activeProjectId]);

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
    refreshProjects();
    refreshDocuments();
    fetchAppConfig()
      .then((c) => {
        const enabled = c.grok?.enabled ?? false;
        setGrokEnabled(enabled);
        setUseGrok(enabled); // on by default so the model can search when needed
      })
      .catch(() => setGrokEnabled(false));
  }, [refresh, refreshDocuments, refreshProjects]);

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
      setActiveProjectId(conv.projectId ?? activeProjectId ?? null);
    },
    [activeProjectId, navigateTo],
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

  const handleTogglePin = useCallback(
    async (id: string, pinned: boolean) => {
      await updateConversationApi(id, { pinned });
      await refresh();
    },
    [refresh],
  );

  const handleMoveConversation = useCallback(
    async (id: string, projectId: string | null) => {
      await updateConversationApi(id, { projectId });
      await refresh();
    },
    [refresh],
  );

  const handleCreateProject = useCallback(async () => {
    const name = window.prompt("Project name");
    if (!name?.trim()) return;
    const project = await createProjectApi(name.trim());
    await refreshProjects();
    setActiveProjectId(project.id);
    navigateTo(null);
  }, [navigateTo, refreshProjects]);

  const handleDeleteMany = useCallback(async () => {
    const scope = activeProjectId
      ? `project "${projects.find((p) => p.id === activeProjectId)?.name ?? "current"}"`
      : "all conversations";
    const includePinned = window.confirm(
      `Delete pinned conversations too in ${scope}? Cancel keeps pinned conversations.`,
    );
    const typed = window.prompt(
      `Type DELETE to delete ${includePinned ? "all" : "unpinned"} conversations in ${scope}.`,
    );
    if (typed !== "DELETE") return;
    const res = await deleteConversationsBulkApi({
      projectId: activeProjectId ?? undefined,
      includePinned,
    });
    if (activeId && res.ids.includes(activeId)) navigateTo(null);
    await refresh();
  }, [activeId, activeProjectId, navigateTo, projects, refresh]);

  const handleSaveProject = useCallback(
    async (
      id: string,
      patch: {
        name: string;
        description: string | null;
        systemPrompt: string | null;
        includeGlobalDocuments: boolean;
      },
    ) => {
      await updateProjectApi(id, patch);
      await refreshProjects();
      await refreshDocuments();
    },
    [refreshDocuments, refreshProjects],
  );

  const handleDeleteProject = useCallback(
    async (id: string, deleteConversations: boolean) => {
      await deleteProjectApi(id, deleteConversations);
      if (activeProjectId === id) {
        setActiveProjectId(null);
        navigateTo(null);
      }
      await refreshProjects();
      await refresh();
      await refreshDocuments();
    },
    [activeProjectId, navigateTo, refresh, refreshDocuments, refreshProjects],
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

  const activeConversation = conversations.find((c) => c.id === activeId) ?? null;
  const activeTitle = activeConversation?.title ?? null;
  const chatProjectId = activeConversation?.projectId ?? activeProjectId;
  const activeProject =
    projects.find((p) => p.id === activeProjectId) ?? null;
  const effectiveDocCount =
    documents.length +
    (activeProject?.includeGlobalDocuments ? globalDocCount : 0);
  const visibleConversations = activeProjectId
    ? conversations.filter((c) => c.projectId === activeProjectId)
    : conversations;

  // Until the device class is known, render a neutral shell to avoid a
  // hydration mismatch between the desktop and mobile component trees.
  if (isMobile === null) return <div className="h-dvh bg-background" />;

  return (
    <div className="flex h-dvh w-full max-w-full overflow-hidden">
      <Sidebar
        conversations={visibleConversations}
        allConversations={conversations}
        projects={projects}
        activeProjectId={activeProjectId}
        activeId={activeId}
        docCount={effectiveDocCount}
        isMobile={isMobile}
        open={sidebarOpen}
        onClose={() => setSidebarOpen(false)}
        onNew={() => {
          navigateTo(null);
          setSidebarOpen(false);
        }}
        onSelect={(id) => {
          navigateTo(id);
          const conv = conversations.find((c) => c.id === id);
          setActiveProjectId(conv?.projectId ?? null);
          setSidebarOpen(false);
        }}
        onSelectProject={(id) => {
          setActiveProjectId(id);
          navigateTo(null);
          setSidebarOpen(false);
        }}
        onShowAll={() => {
          setActiveProjectId(null);
          navigateTo(null);
          setSidebarOpen(false);
        }}
        onCreateProject={handleCreateProject}
        onEditProject={(id) =>
          setEditingProject(projects.find((p) => p.id === id) ?? null)
        }
        onRename={handleRename}
        onDelete={handleDelete}
        onTogglePin={handleTogglePin}
        onMoveConversation={handleMoveConversation}
        onDeleteMany={handleDeleteMany}
        onOpenDocs={() => setDocsOpen(true)}
        onOpenSkills={() => setSkillsOpen(true)}
        onOpenDashboard={() => setDashboardOpen(true)}
        onOpenSettings={() => setSettingsOpen(true)}
      />
      <Chat
        conversationId={activeId}
        title={activeTitle}
        projectId={chatProjectId}
        isMobile={isMobile}
        onOpenSidebar={() => setSidebarOpen(true)}
        useRag={useRag}
        docCount={effectiveDocCount}
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
        projectId={activeProjectId}
        projectName={activeProject?.name ?? null}
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
      <ProjectSettingsModal
        project={editingProject}
        onClose={() => setEditingProject(null)}
        onSave={handleSaveProject}
        onDelete={handleDeleteProject}
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
