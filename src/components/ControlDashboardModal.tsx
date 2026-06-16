"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import {
  Activity,
  Ban,
  ClipboardList,
  RefreshCw,
  Square,
  Terminal,
  X,
} from "lucide-react";
import {
  fetchBackgroundJob,
  fetchBackgroundJobs,
  fetchSopEvents,
  killBackgroundJobApi,
  type BackgroundJob,
  type SopControlEvent,
} from "@/lib/api";
import type { BgStatus } from "@/lib/types";

function formatTime(ms: number | null): string {
  if (!ms) return "-";
  return new Date(ms).toLocaleString();
}

function statusClass(status: BgStatus | "pass" | "fail"): string {
  if (status === "running") return "text-sky-300";
  if (status === "pass" || status === "exited") return "text-emerald-300";
  if (status === "killed" || status === "timeout" || status === "fail") {
    return "text-red-300";
  }
  return "text-amber-300";
}

function shortId(id: string | null): string {
  if (!id) return "-";
  return id.length > 10 ? `${id.slice(0, 10)}...` : id;
}

export function ControlDashboardModal({
  open,
  activeConversationId,
  onClose,
}: {
  open: boolean;
  activeConversationId: string | null;
  onClose: () => void;
}) {
  const [tab, setTab] = useState<"jobs" | "sop">("jobs");
  const [currentOnly, setCurrentOnly] = useState(false);
  const [status, setStatus] = useState<BgStatus | "">("");
  const [jobs, setJobs] = useState<BackgroundJob[]>([]);
  const [events, setEvents] = useState<SopControlEvent[]>([]);
  const [selectedJob, setSelectedJob] = useState<BackgroundJob | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const conversationId = currentOnly ? activeConversationId : null;

  const load = useCallback(async () => {
    if (!open) return;
    setError(null);
    try {
      const [nextJobs, nextEvents] = await Promise.all([
        fetchBackgroundJobs({
          conversationId,
          status: status || null,
          limit: 100,
        }),
        fetchSopEvents({ conversationId, limit: 100 }),
      ]);
      setJobs(nextJobs);
      setEvents(nextEvents);
      if (selectedJob) {
        const fresh = await fetchBackgroundJob(selectedJob.id);
        setSelectedJob(fresh);
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : "Dashboard refresh failed");
    }
  }, [conversationId, open, selectedJob, status]);

  useEffect(() => {
    if (!open) return;
    load();
    const id = window.setInterval(load, 3000);
    return () => window.clearInterval(id);
  }, [load, open]);

  const runningCount = useMemo(
    () => jobs.filter((j) => j.status === "running").length,
    [jobs],
  );

  async function selectJob(job: BackgroundJob) {
    setError(null);
    try {
      setSelectedJob(await fetchBackgroundJob(job.id));
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to load log");
    }
  }

  async function killJob(id: string) {
    setBusy(true);
    setError(null);
    try {
      await killBackgroundJobApi(id);
      const fresh = await fetchBackgroundJob(id).catch(() => null);
      if (fresh) setSelectedJob(fresh);
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Kill failed");
    } finally {
      setBusy(false);
    }
  }

  if (!open) return null;

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4"
      onClick={onClose}
    >
      <div
        className="flex max-h-[88vh] w-full max-w-5xl flex-col rounded-lg border border-border bg-surface shadow-xl"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex flex-wrap items-center justify-between gap-3 border-b border-border px-5 py-3">
          <div className="flex items-center gap-2">
            <Activity size={17} className="text-accent" />
            <h2 className="text-sm font-semibold">Jobs / SOP Console</h2>
            <span className="text-xs text-muted">{runningCount} running</span>
          </div>
          <div className="flex items-center gap-2">
            <button
              onClick={load}
              className="rounded-lg p-1.5 text-muted hover:bg-surface-2 hover:text-foreground"
              title="Refresh"
            >
              <RefreshCw size={16} />
            </button>
            <button
              onClick={onClose}
              className="rounded-lg p-1.5 text-muted hover:bg-surface-2 hover:text-foreground"
              title="Close"
            >
              <X size={18} />
            </button>
          </div>
        </div>

        <div className="flex flex-wrap items-center gap-3 border-b border-border px-5 py-3">
          <div className="flex overflow-hidden rounded-lg border border-border">
            <button
              onClick={() => setTab("jobs")}
              className={`flex items-center gap-2 px-3 py-1.5 text-xs ${
                tab === "jobs"
                  ? "bg-accent-strong text-white"
                  : "text-muted hover:text-foreground"
              }`}
            >
              <Terminal size={14} /> Jobs
            </button>
            <button
              onClick={() => setTab("sop")}
              className={`flex items-center gap-2 px-3 py-1.5 text-xs ${
                tab === "sop"
                  ? "bg-accent-strong text-white"
                  : "text-muted hover:text-foreground"
              }`}
            >
              <ClipboardList size={14} /> SOP
            </button>
          </div>

          <label className="flex items-center gap-2 text-xs text-muted">
            <input
              type="checkbox"
              checked={currentOnly}
              disabled={!activeConversationId}
              onChange={(e) => setCurrentOnly(e.target.checked)}
            />
            Current conversation
          </label>

          {tab === "jobs" && (
            <select
              value={status}
              onChange={(e) => setStatus(e.target.value as BgStatus | "")}
              className="rounded-lg border border-border bg-surface-2 px-2 py-1 text-xs outline-none focus:border-accent"
            >
              <option value="">All statuses</option>
              <option value="running">running</option>
              <option value="exited">exited</option>
              <option value="killed">killed</option>
              <option value="timeout">timeout</option>
              <option value="terminated">terminated</option>
            </select>
          )}

          {error && <span className="text-xs text-red-300">{error}</span>}
        </div>

        {tab === "jobs" ? (
          <div className="grid min-h-0 flex-1 grid-cols-1 overflow-hidden md:grid-cols-[minmax(0,1fr)_minmax(320px,42%)]">
            <div className="min-h-0 overflow-auto border-b border-border md:border-b-0 md:border-r">
              <table className="w-full text-left text-xs">
                <thead className="sticky top-0 bg-surface text-muted">
                  <tr>
                    <th className="px-4 py-2 font-medium">Job</th>
                    <th className="px-4 py-2 font-medium">Conversation</th>
                    <th className="px-4 py-2 font-medium">Status</th>
                    <th className="px-4 py-2 font-medium">Exit</th>
                    <th className="px-4 py-2 font-medium">Started</th>
                    <th className="px-4 py-2 font-medium">Command</th>
                  </tr>
                </thead>
                <tbody>
                  {jobs.map((job) => (
                    <tr
                      key={job.id}
                      className="cursor-pointer border-t border-border hover:bg-surface-2"
                      onClick={() => selectJob(job)}
                    >
                      <td className="whitespace-nowrap px-4 py-2 font-mono">
                        {job.id}
                      </td>
                      <td className="px-4 py-2 font-mono">
                        {shortId(job.conversationId)}
                      </td>
                      <td className={`px-4 py-2 ${statusClass(job.status)}`}>
                        {job.status}
                      </td>
                      <td className="px-4 py-2">{job.exitCode ?? "-"}</td>
                      <td className="whitespace-nowrap px-4 py-2">
                        {formatTime(job.startedAt)}
                      </td>
                      <td className="max-w-[260px] truncate px-4 py-2 font-mono">
                        {job.command}
                      </td>
                    </tr>
                  ))}
                  {jobs.length === 0 && (
                    <tr>
                      <td colSpan={6} className="px-4 py-8 text-center text-muted">
                        No background jobs.
                      </td>
                    </tr>
                  )}
                </tbody>
              </table>
            </div>

            <div className="flex min-h-0 flex-col">
              {selectedJob ? (
                <>
                  <div className="border-b border-border px-4 py-3 text-xs">
                    <div className="mb-2 flex items-center justify-between gap-3">
                      <div className="min-w-0">
                        <div className="font-mono text-sm">{selectedJob.id}</div>
                        <div className="truncate text-muted">
                          {selectedJob.command}
                        </div>
                      </div>
                      <button
                        onClick={() => killJob(selectedJob.id)}
                        disabled={busy || selectedJob.status !== "running"}
                        className="flex items-center gap-1.5 rounded-lg border border-red-500/40 px-2 py-1 text-red-300 disabled:border-border disabled:text-muted"
                        title="Kill job"
                      >
                        <Square size={13} /> Kill
                      </button>
                    </div>
                    <div className="grid grid-cols-2 gap-2 text-muted">
                      <span>
                        Status{" "}
                        <b className={statusClass(selectedJob.status)}>
                          {selectedJob.status}
                        </b>
                      </span>
                      <span>Exit {selectedJob.exitCode ?? "-"}</span>
                      <span>Started {formatTime(selectedJob.startedAt)}</span>
                      <span>Ended {formatTime(selectedJob.endedAt)}</span>
                      <span className="col-span-2">
                        Timeout {formatTime(selectedJob.timeoutAt)}
                      </span>
                    </div>
                  </div>
                  <pre className="min-h-0 flex-1 overflow-auto whitespace-pre-wrap p-4 font-mono text-xs leading-relaxed text-foreground">
                    {selectedJob.logTail ?? selectedJob.log ?? "(no output)"}
                  </pre>
                </>
              ) : (
                <div className="flex flex-1 items-center justify-center gap-2 text-sm text-muted">
                  <Ban size={16} /> Select a job to view its log.
                </div>
              )}
            </div>
          </div>
        ) : (
          <div className="min-h-0 flex-1 overflow-auto">
            <table className="w-full text-left text-xs">
              <thead className="sticky top-0 bg-surface text-muted">
                <tr>
                  <th className="px-4 py-2 font-medium">Time</th>
                  <th className="px-4 py-2 font-medium">Conversation</th>
                  <th className="px-4 py-2 font-medium">Message</th>
                  <th className="px-4 py-2 font-medium">Phase</th>
                  <th className="px-4 py-2 font-medium">Status</th>
                  <th className="px-4 py-2 font-medium">Rounds</th>
                  <th className="px-4 py-2 font-medium">Action</th>
                  <th className="px-4 py-2 font-medium">Violations</th>
                </tr>
              </thead>
              <tbody>
                {events.map((event) => (
                  <tr key={event.id} className="border-t border-border">
                    <td className="whitespace-nowrap px-4 py-2">
                      {formatTime(event.createdAt)}
                    </td>
                    <td className="px-4 py-2 font-mono">
                      {shortId(event.conversationId)}
                    </td>
                    <td className="px-4 py-2 font-mono">
                      {shortId(event.messageId)}
                    </td>
                    <td className="px-4 py-2">{event.phase}</td>
                    <td className={`px-4 py-2 ${statusClass(event.status)}`}>
                      {event.status}
                    </td>
                    <td className="px-4 py-2">{event.correctionRounds}</td>
                    <td className="px-4 py-2">{event.action}</td>
                    <td className="max-w-[360px] px-4 py-2">
                      {event.violations.length
                        ? event.violations.join("; ")
                        : "-"}
                    </td>
                  </tr>
                ))}
                {events.length === 0 && (
                  <tr>
                    <td colSpan={8} className="px-4 py-8 text-center text-muted">
                      No SOP events.
                    </td>
                  </tr>
                )}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </div>
  );
}
