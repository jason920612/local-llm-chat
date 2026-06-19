import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { nanoid } from "nanoid";
import { config } from "../config";
import {
  type SandboxDriver,
  type RunResult,
  type CloneResult,
  type ActionSequence,
  type ActionSequenceResult,
  type ComputerObservation,
  type BrowserActionResult,
  type BrowserObservation,
  type WatchVideoOptions,
  type WatchVideoResult,
  type WatchVideoFrame,
  type InspectVideoMomentsOptions,
  type InspectVideoMomentsResult,
  type LookCloserOptions,
  type LookCloserResult,
  safeConvId,
  normalizeRepoUrl,
  repoDirName,
} from "./driver";
import { listFiles, emptyResult, cloneTree } from "./fsutil";
import { ensureDetector } from "./detector";

/**
 * Cap how many conversation VMs may be alive at once. A VM slot is held for the
 * lifetime of that conversation session, not just while it boots.
 */
let vmActive = 0;
const vmQueue: Array<() => void> = [];
async function acquireVmSlot(max: number): Promise<void> {
  if (vmActive < max) {
    vmActive++;
    return;
  }
  await new Promise<void>((resolve) => vmQueue.push(resolve));
  vmActive++;
}
function releaseVmSlot(): void {
  vmActive = Math.max(0, vmActive - 1);
  vmQueue.shift()?.();
}

let lastCleanup = 0;

interface VmSession {
  key: string;
  child: ChildProcess;
  startedAt: number;
  stderr: string;
  exited: boolean;
}

const globalForVm = globalThis as unknown as {
  __llmVmSessions?: Map<string, VmSession>;
  __llmVmStarting?: Map<string, Promise<VmSession>>;
};
const sessions =
  globalForVm.__llmVmSessions ?? (globalForVm.__llmVmSessions = new Map());
const starting =
  globalForVm.__llmVmStarting ?? (globalForVm.__llmVmStarting = new Map());

/**
 * MicroVMDriver: one long-lived Cloud Hypervisor VM per conversation. The guest
 * runs a small daemon that accepts many concurrent jobs through files under
 * `.run/jobs/<job-id>/`.
 */
export class MicroVMDriver implements SandboxDriver {
  readonly name = "microvm" as const;

  private get cfg() {
    return config.sandbox.microvm;
  }

  private toUnc(wslPath: string): string {
    const rel = wslPath.replace(/^\/+/, "").replace(/\//g, "\\");
    return `\\\\wsl.localhost\\${this.cfg.wslDistro}\\${rel}`;
  }

  sandboxRootHostPath(): string {
    return this.toUnc(this.cfg.wslSandboxRoot);
  }

  private convDirHostPath(conversationId: string): string {
    return path.win32.join(this.sandboxRootHostPath(), safeConvId(conversationId));
  }

  workspaceHostPath(conversationId: string): string {
    return path.win32.join(this.convDirHostPath(conversationId), "ws");
  }

  prepareWorkspace(conversationId: string): string {
    const dir = this.workspaceHostPath(conversationId);
    fs.mkdirSync(path.win32.join(dir, ".run", "jobs"), { recursive: true });
    void this.cleanupOld();
    return dir;
  }

  private async cleanupOld(): Promise<void> {
    const now = Date.now();
    if (now - lastCleanup < 10 * 60 * 1000) return;
    lastCleanup = now;
    const root = path.win32.resolve(this.sandboxRootHostPath());
    const fsp = fs.promises;
    try {
      let names: string[];
      try {
        names = await fsp.readdir(root);
      } catch {
        return;
      }
      for (const name of names) {
        const p = path.win32.resolve(root, name);
        if (!p.startsWith(root + path.win32.sep)) continue;
        try {
          const st = await fsp.stat(p);
          if (st.isDirectory() && now - st.mtimeMs > config.sandbox.ttlMs) {
            // Stop any VM still attached to this conversation before removing its
            // workspace, so the TTL reaper can never orphan a running VM.
            this.stopVmInWsl(name);
            await fsp.rm(p, { recursive: true, force: true });
          }
        } catch {
          /* ignore */
        }
      }
    } catch {
      /* ignore */
    }
  }

  deleteSandbox(conversationId: string): void {
    this.killSession(conversationId);
    const root = path.win32.resolve(this.sandboxRootHostPath());
    const dir = path.win32.resolve(this.convDirHostPath(conversationId));
    if (!dir.startsWith(root + path.win32.sep) || dir === root) return;
    try {
      fs.rmSync(dir, { recursive: true, force: true });
    } catch {
      /* ignore */
    }
  }

  async runCode(
    conversationId: string,
    language: "python" | "bash",
    code: string,
    opts?: { timeoutMs?: number; jobId?: string },
  ): Promise<RunResult> {
    const cap = config.sandbox.maxOutputChars;
    const timeoutMs = Math.min(
      opts?.timeoutMs ?? config.sandbox.timeoutMs,
      this.cfg.maxRunMs,
    );
    const jobId = this.safeJobId(opts?.jobId ?? `fg_${nanoid(10)}`);
    return this.runVmRequest(
      conversationId,
      jobId,
      {
        id: jobId,
        type: "run_code",
        language,
        code,
        timeoutMs,
        maxOutputChars: cap,
      },
      timeoutMs,
      cap,
    );
  }

  killRun(conversationId: string, jobId?: string): boolean {
    if (jobId) {
      try {
        const p = path.win32.join(
          this.workspaceHostPath(conversationId),
          ".run",
          "jobs",
          this.safeJobId(jobId),
          "kill",
        );
        fs.writeFileSync(p, String(Date.now()));
        return true;
      } catch {
        return false;
      }
    }
    return this.killSession(conversationId);
  }

  async cloneRepo(
    conversationId: string,
    repoUrl: string,
  ): Promise<CloneResult> {
    const url = normalizeRepoUrl(repoUrl);
    if (!url) {
      return { ok: false, dir: "", tree: "", error: `invalid repo: ${repoUrl}` };
    }
    const base = repoDirName(url);
    const q = `'${url.replace(/'/g, "'\\''")}'`;
    const script = `rm -rf ${base} && git clone --depth 1 ${q} ${base} 2>&1`;
    const r = await this.runCode(conversationId, "bash", script);
    if ((r.exitCode ?? 1) !== 0) {
      return {
        ok: false,
        dir: base,
        tree: "",
        error: (r.stdout || r.stderr || r.error || "git clone failed").slice(-600),
      };
    }
    const dest = path.win32.join(this.workspaceHostPath(conversationId), base);
    return { ok: true, dir: base, tree: await cloneTree(dest, base) };
  }

  async computerObserve(
    conversationId: string,
    opts: {
      includeScreenshot?: boolean;
      ocr?: boolean;
      mark?: boolean;
      remark?: boolean;
      caption?: boolean;
    } = {},
  ): Promise<ComputerObservation> {
    if (!this.cfg.computer.enabled) {
      return {
        ok: false,
        windows: [],
        elements: [],
        error: "VM computer use is disabled",
      };
    }
    const det = this.cfg.detector;
    const wantMark = Boolean(opts.mark) && this.cfg.computer.marking;
    // Set-of-Mark detection runs on the host GPU service — make sure it's up.
    if (wantMark && det.enabled) ensureDetector();
    const jobId = this.safeJobId(`cu_obs_${nanoid(8)}`);
    const result = await this.runVmRequest(
      conversationId,
      jobId,
      {
        id: jobId,
        type: "computer_observe",
        timeoutMs: 20 * 60 * 1000,
        maxOutputChars: 2_000_000,
        includeScreenshot: Boolean(opts.includeScreenshot),
        ocr: opts.ocr ?? this.cfg.computer.ocr,
        mark: wantMark,
        remark: Boolean(opts.remark),
        caption: opts.caption ?? det.caption,
        markDiffThreshold: this.cfg.computer.markDiffThreshold,
        detectorConf: det.conf,
        detectorMaxBoxes: det.maxBoxes,
        detectorImgsz: det.imgsz,
        detectorOpencv: det.opencv,
        autoInstall: this.cfg.computer.autoInstall,
        width: this.cfg.computer.width,
        height: this.cfg.computer.height,
      },
      20 * 60 * 1000,
      2_000_000,
    );
    return this.parseComputerObservation(result);
  }

  async lookCloser(
    conversationId: string,
    opts: LookCloserOptions,
  ): Promise<LookCloserResult> {
    const jobId = this.safeJobId(`cu_zoom_${nanoid(8)}`);
    const result = await this.runVmRequest(
      conversationId,
      jobId,
      {
        id: jobId,
        type: "look_closer",
        timeoutMs: 60_000,
        maxOutputChars: 4_000_000,
        mark: opts.mark,
        bbox: opts.bbox,
        state: opts.state ?? "computer",
        pad: opts.pad,
      },
      60_000,
      4_000_000,
    );
    if (result.error || result.stderr) {
      return { ok: false, error: result.error ?? result.stderr };
    }
    try {
      const parsed = JSON.parse(result.stdout) as {
        ok?: boolean;
        crop?: { dataUrl?: string };
        region?: [number, number, number, number];
        error?: string;
      };
      if (!parsed.ok) return { ok: false, error: parsed.error ?? "look_closer failed" };
      return { ok: true, dataUrl: parsed.crop?.dataUrl, region: parsed.region };
    } catch (e) {
      return { ok: false, error: `invalid look_closer result: ${String(e)}` };
    }
  }

  async computerAction(
    conversationId: string,
    seq: ActionSequence,
  ): Promise<ActionSequenceResult> {
    if (!this.cfg.computer.enabled) {
      return { ok: false, steps: [], error: "VM computer use is disabled" };
    }
    const jobId = this.safeJobId(`cu_act_${nanoid(8)}`);
    const result = await this.runVmRequest(
      conversationId,
      jobId,
      {
        id: jobId,
        type: "computer_action",
        timeoutMs: 20 * 60 * 1000,
        maxOutputChars: 2_000_000,
        autoInstall: this.cfg.computer.autoInstall,
        width: this.cfg.computer.width,
        height: this.cfg.computer.height,
        humanMouse: this.cfg.computer.humanMouse,
        humanMouseMaxSteps: this.cfg.computer.humanMouseMaxSteps,
        humanMouseJitter: this.cfg.computer.humanMouseJitter,
        steps: seq.steps ?? [],
        includeScreenshot: Boolean(seq.includeScreenshot),
      },
      20 * 60 * 1000,
      2_000_000,
    );
    return this.parseSequenceResult(result);
  }

  async browserOpenUrl(
    conversationId: string,
    url: string,
  ): Promise<BrowserActionResult> {
    const jobId = this.safeJobId(`br_open_${nanoid(8)}`);
    const result = await this.runVmRequest(
      conversationId,
      jobId,
      {
        id: jobId,
        type: "browser_open_url",
        timeoutMs: 20 * 60 * 1000,
        maxOutputChars: 100_000,
        autoInstall: this.cfg.computer.autoInstall,
        width: this.cfg.computer.width,
        height: this.cfg.computer.height,
        url,
      },
      20 * 60 * 1000,
      100_000,
    );
    return this.parseBrowserActionResult(result, "browser_open_url");
  }

  async browserObserve(
    conversationId: string,
    opts: {
      includeScreenshot?: boolean;
      mark?: boolean;
      remark?: boolean;
      caption?: boolean;
    } = {},
  ): Promise<BrowserObservation> {
    const det = this.cfg.detector;
    const wantMark = Boolean(opts.mark) && this.cfg.computer.marking;
    if (wantMark && det.enabled) ensureDetector();
    const jobId = this.safeJobId(`br_obs_${nanoid(8)}`);
    const result = await this.runVmRequest(
      conversationId,
      jobId,
      {
        id: jobId,
        type: "browser_observe",
        timeoutMs: 20 * 60 * 1000,
        maxOutputChars: 2_000_000,
        autoInstall: this.cfg.computer.autoInstall,
        width: this.cfg.computer.width,
        height: this.cfg.computer.height,
        includeScreenshot: Boolean(opts.includeScreenshot),
        mark: wantMark,
        remark: Boolean(opts.remark),
        caption: opts.caption ?? det.caption,
        markDiffThreshold: this.cfg.computer.markDiffThreshold,
        detectorConf: det.conf,
        detectorMaxBoxes: det.maxBoxes,
        detectorImgsz: det.imgsz,
        detectorOpencv: det.opencv,
      },
      20 * 60 * 1000,
      2_000_000,
    );
    return this.parseBrowserObservation(result);
  }

  async browserAction(
    conversationId: string,
    seq: ActionSequence,
  ): Promise<ActionSequenceResult> {
    const jobId = this.safeJobId(`br_act_${nanoid(8)}`);
    const result = await this.runVmRequest(
      conversationId,
      jobId,
      {
        id: jobId,
        type: "browser_action",
        timeoutMs: 20 * 60 * 1000,
        maxOutputChars: 2_000_000,
        autoInstall: this.cfg.computer.autoInstall,
        width: this.cfg.computer.width,
        height: this.cfg.computer.height,
        humanMouse: this.cfg.computer.humanMouse,
        humanMouseMaxSteps: this.cfg.computer.humanMouseMaxSteps,
        humanMouseJitter: this.cfg.computer.humanMouseJitter,
        steps: seq.steps ?? [],
        includeScreenshot: Boolean(seq.includeScreenshot),
      },
      20 * 60 * 1000,
      2_000_000,
    );
    return this.parseSequenceResult(result);
  }

  async watchVideo(
    conversationId: string,
    opts: WatchVideoOptions,
  ): Promise<WatchVideoResult> {
    const vcfg = this.cfg.video;
    if (!vcfg.enabled) {
      return { ok: false, frames: [], error: "watch_video is disabled" };
    }
    const source = (opts.source ?? "").trim();
    if (!source) {
      return { ok: false, frames: [], error: "source is required" };
    }
    const wantAudio = opts.audio ?? vcfg.audio;
    const jobId = this.safeJobId(`vid_${nanoid(8)}`);
    const result = await this.runVmRequest(
      conversationId,
      jobId,
      {
        id: jobId,
        type: "watch_video",
        timeoutMs: vcfg.maxJobMs,
        maxOutputChars: 4_000_000,
        source,
        audio: wantAudio,
        // Frame sampling knobs (scene-detection + duration-scaled budget).
        framesPerMin: vcfg.framesPerMin,
        frameFloor: vcfg.frameFloor,
        frameCeiling: opts.frameCeiling ?? vcfg.frameCeiling,
        sceneThreshold: vcfg.sceneThreshold,
        frameLongEdge: vcfg.frameLongEdge,
        sttChunkSec: vcfg.sttChunkSec,
        maxQualityHeight: vcfg.maxQualityHeight,
        // Browser-playback fallback (only usable when computer use is enabled).
        allowBrowserFallback: this.cfg.computer.enabled,
        browserPlaybackRate: vcfg.browserPlaybackRate,
        browserCaptureCapSec: vcfg.browserCaptureCapSec,
        autoInstall: this.cfg.computer.autoInstall,
        width: this.cfg.computer.width,
        height: this.cfg.computer.height,
      },
      vcfg.maxJobMs,
      4_000_000,
    );
    return this.parseWatchVideoResult(conversationId, result, jobId);
  }

  async inspectVideoMoments(
    conversationId: string,
    opts: InspectVideoMomentsOptions,
  ): Promise<InspectVideoMomentsResult> {
    const vcfg = this.cfg.video;
    if (!vcfg.enabled) {
      return {
        ok: false,
        frames: [],
        error: "inspect_video_moments is disabled",
      };
    }
    const rawVideoId = (opts.videoId ?? "").trim();
    if (!rawVideoId) {
      return { ok: false, frames: [], error: "video_id is required" };
    }
    const videoId = this.safeJobId(rawVideoId);
    if (videoId !== rawVideoId) {
      return { ok: false, frames: [], error: "invalid video_id" };
    }
    const moments = (opts.moments ?? [])
      .map((m) => ({
        timeSec: Number(m.timeSec),
        reason: typeof m.reason === "string" ? m.reason.slice(0, 200) : "",
      }))
      .filter((m) => Number.isFinite(m.timeSec) && m.timeSec >= 0)
      .slice(0, 24);
    if (!moments.length) {
      return {
        ok: false,
        frames: [],
        error: "at least one valid moment is required",
      };
    }
    const jobId = this.safeJobId(`vid_inspect_${nanoid(8)}`);
    const result = await this.runVmRequest(
      conversationId,
      jobId,
      {
        id: jobId,
        type: "inspect_video_moments",
        timeoutMs: vcfg.maxJobMs,
        maxOutputChars: 2_000_000,
        videoId,
        moments,
        windowSec: opts.windowSec ?? 8,
        framesPerMoment: opts.framesPerMoment ?? 3,
        frameLongEdge: vcfg.frameLongEdge,
      },
      vcfg.maxJobMs,
      2_000_000,
    );
    return this.parseInspectVideoMomentsResult(conversationId, result);
  }

  /**
   * The guest writes frame JPEGs into the workspace and returns their
   * workspace-relative paths (keeping result.json small). Here we read each
   * frame file over the virtiofs share and inline it as a base64 data URL for
   * the image-vision path.
   */
  private parseWatchVideoResult(
    conversationId: string,
    result: RunResult,
    fallbackVideoId: string,
  ): WatchVideoResult {
    if (result.error || result.stderr) {
      return { ok: false, frames: [], error: result.error ?? result.stderr };
    }
    let raw: {
      ok?: boolean;
      videoId?: string;
      via?: "file" | "yt-dlp" | "browser";
      title?: string;
      durationSec?: number;
      frames?: { file?: string; tSec?: number; score?: number }[];
      frameCeilingHit?: boolean;
      audioChunks?: { file?: string; startSec?: number }[];
      note?: string;
      error?: string;
    };
    try {
      raw = JSON.parse(result.stdout);
    } catch (e) {
      return {
        ok: false,
        frames: [],
        error: `invalid watch_video result: ${String(e)}; ${result.stdout.slice(0, 500)}`,
      };
    }
    if (raw.error || raw.ok === false) {
      return { ok: false, frames: [], error: raw.error ?? "watch_video failed" };
    }
    const frames: WatchVideoFrame[] = [];
    for (const f of raw.frames ?? []) {
      if (!f.file) continue;
      const buf = this.readWorkspaceFile(conversationId, f.file);
      if (!buf) continue;
      frames.push({
        dataUrl: `data:image/jpeg;base64,${buf.toString("base64")}`,
        tSec: f.tSec ?? 0,
        score: f.score,
      });
    }
    const audioChunks = [];
    for (const a of raw.audioChunks ?? []) {
      if (!a.file) continue;
      const buf = this.readWorkspaceFile(conversationId, a.file);
      if (!buf) continue;
      audioChunks.push({
        bytes: new Uint8Array(buf),
        startSec: a.startSec ?? 0,
        filename: a.file.split(/[/\\]/).pop() || "chunk.mp3",
      });
    }
    return {
      ok: true,
      videoId: raw.videoId ?? fallbackVideoId,
      via: raw.via,
      title: raw.title,
      durationSec: raw.durationSec,
      frames,
      frameCeilingHit: raw.frameCeilingHit,
      audioChunks,
      note: raw.note,
    };
  }

  private parseInspectVideoMomentsResult(
    conversationId: string,
    result: RunResult,
  ): InspectVideoMomentsResult {
    if (result.error || result.stderr) {
      return { ok: false, frames: [], error: result.error ?? result.stderr };
    }
    let raw: {
      ok?: boolean;
      videoId?: string;
      title?: string;
      durationSec?: number;
      frames?: {
        file?: string;
        tSec?: number;
        score?: number;
        momentIndex?: number;
        reason?: string;
      }[];
      error?: string;
    };
    try {
      raw = JSON.parse(result.stdout);
    } catch (e) {
      return {
        ok: false,
        frames: [],
        error: `invalid inspect_video_moments result: ${String(e)}; ${result.stdout.slice(0, 500)}`,
      };
    }
    if (raw.error || raw.ok === false) {
      return {
        ok: false,
        frames: [],
        error: raw.error ?? "inspect_video_moments failed",
      };
    }
    const frames: WatchVideoFrame[] = [];
    for (const f of raw.frames ?? []) {
      if (!f.file) continue;
      const buf = this.readWorkspaceFile(conversationId, f.file);
      if (!buf) continue;
      frames.push({
        dataUrl: `data:image/jpeg;base64,${buf.toString("base64")}`,
        tSec: f.tSec ?? 0,
        score: f.score,
        momentIndex: f.momentIndex,
        reason: f.reason,
      });
    }
    return {
      ok: true,
      videoId: raw.videoId,
      title: raw.title,
      durationSec: raw.durationSec,
      frames,
    };
  }

  private readWorkspaceFile(conversationId: string, rel: string): Buffer | null {
    if (path.win32.isAbsolute(rel) || rel.split(/[\\/]+/).includes("..")) {
      return null;
    }
    const wsRoot = this.workspaceHostPath(conversationId);
    const r = rel.replace(/^[/\\]+/, "").replace(/\//g, "\\");
    try {
      const root = path.win32.resolve(wsRoot);
      const target = path.win32.resolve(path.win32.join(root, r));
      if (target !== root && !target.startsWith(root + path.win32.sep)) {
        return null;
      }
      return fs.readFileSync(target);
    } catch {
      return null;
    }
  }

  private parseSequenceResult(result: RunResult): ActionSequenceResult {
    if (result.error || result.stderr) {
      return { ok: false, steps: [], error: result.error ?? result.stderr };
    }
    try {
      return JSON.parse(result.stdout) as ActionSequenceResult;
    } catch (e) {
      return {
        ok: false,
        steps: [],
        error: `invalid action result: ${String(e)}; ${result.stdout.slice(0, 500)}`,
      };
    }
  }

  private safeJobId(jobId: string): string {
    const safe = jobId.replace(/[^A-Za-z0-9_-]/g, "_").slice(0, 80);
    return safe || `job_${nanoid(8)}`;
  }

  private async runVmRequest(
    conversationId: string,
    jobId: string,
    request: Record<string, unknown>,
    timeoutMs: number,
    cap: number,
  ): Promise<RunResult> {
    const dir = this.prepareWorkspace(conversationId);
    const safeJobId = this.safeJobId(jobId);
    const jobDir = path.win32.join(dir, ".run", "jobs", safeJobId);
    const start = Date.now();

    const session = await this.ensureSession(conversationId);
    if (session.exited) {
      return emptyResult({ error: "microVM session exited before job started" });
    }

    try {
      await fs.promises.mkdir(jobDir, { recursive: true });
      await fs.promises.rm(path.win32.join(jobDir, "result.json"), {
        force: true,
      });
      await fs.promises.rm(path.win32.join(jobDir, "kill"), { force: true });
      await this.writeJsonAtomic(path.win32.join(jobDir, "request.json"), {
        ...request,
        id: safeJobId,
      });
    } catch (e) {
      return emptyResult({ error: `failed to stage VM job: ${String(e)}` });
    }

    return this.waitForJob(conversationId, safeJobId, start, timeoutMs, cap);
  }

  private parseComputerObservation(result: RunResult): ComputerObservation {
    if (result.error || result.stderr) {
      return {
        ok: false,
        windows: [],
        elements: [],
        error: result.error ?? result.stderr,
      };
    }
    try {
      const parsed = JSON.parse(result.stdout) as ComputerObservation;
      return {
        ...parsed,
        windows: Array.isArray(parsed.windows) ? parsed.windows : [],
        elements: Array.isArray(parsed.elements) ? parsed.elements : [],
      };
    } catch (e) {
      return {
        ok: false,
        windows: [],
        elements: [],
        error: `invalid computer observation: ${String(e)}; ${result.stdout.slice(0, 500)}`,
      };
    }
  }

  private parseBrowserObservation(result: RunResult): BrowserObservation {
    if (result.error || result.stderr) {
      return {
        ok: false,
        windows: [],
        elements: [],
        error: result.error ?? result.stderr,
      };
    }
    try {
      const parsed = JSON.parse(result.stdout) as BrowserObservation;
      return {
        ...parsed,
        windows: Array.isArray(parsed.windows) ? parsed.windows : [],
        elements: Array.isArray(parsed.elements) ? parsed.elements : [],
      };
    } catch (e) {
      return {
        ok: false,
        windows: [],
        elements: [],
        error: `invalid browser observation: ${String(e)}; ${result.stdout.slice(0, 500)}`,
      };
    }
  }

  private parseBrowserActionResult(
    result: RunResult,
    fallbackAction: string,
  ): BrowserActionResult {
    if (result.error || result.stderr) {
      return {
        ok: false,
        action: fallbackAction,
        durationMs: result.durationMs,
        error: result.error ?? result.stderr,
      };
    }
    try {
      const parsed = JSON.parse(result.stdout) as BrowserActionResult;
      return {
        ...parsed,
        action: parsed.action ?? fallbackAction,
        durationMs: parsed.durationMs ?? result.durationMs,
      };
    } catch (e) {
      return {
        ok: false,
        action: fallbackAction,
        durationMs: result.durationMs,
        error: `invalid browser action result: ${String(e)}; ${result.stdout.slice(0, 500)}`,
      };
    }
  }

  private async ensureSession(conversationId: string): Promise<VmSession> {
    const key = safeConvId(conversationId);
    const existing = sessions.get(key);
    if (existing && !existing.exited && (await this.daemonReady(conversationId))) {
      return existing;
    }
    if (existing?.exited) sessions.delete(key);
    const pending = starting.get(key);
    if (pending) return pending;
    const promise = this.startSession(conversationId, key).finally(() =>
      starting.delete(key),
    );
    starting.set(key, promise);
    return promise;
  }

  private async startSession(
    conversationId: string,
    key: string,
  ): Promise<VmSession> {
    const dir = this.prepareWorkspace(conversationId);
    await fs.promises.mkdir(path.win32.join(dir, ".run", "jobs"), {
      recursive: true,
    });
    await this.writeJsonAtomic(path.win32.join(dir, ".run", "session.json"), {
      idleSeconds: Math.max(30, Math.floor(this.cfg.idleMs / 1000)),
      computer: {
        enabled: this.cfg.computer.enabled,
        autoInstall: this.cfg.computer.autoInstall,
        ocr: this.cfg.computer.ocr,
        width: this.cfg.computer.width,
        height: this.cfg.computer.height,
      },
    });
    await fs.promises.rm(path.win32.join(dir, ".run", "daemon.json"), {
      force: true,
    });

    await acquireVmSlot(this.cfg.maxConcurrent);
    const timeoutSec = Math.ceil(this.cfg.sessionMaxMs / 1000);
    const args = [
      "-d",
      this.cfg.wslDistro,
      "--",
      "sudo",
      "-n",
      "/usr/local/sbin/llm-vm-run",
      key,
      String(this.cfg.vcpus),
      String(this.cfg.memMiB),
      String(timeoutSec),
      String(this.cfg.systemDiskGiB),
    ];

    let child: ChildProcess;
    try {
      child = spawn("wsl.exe", args, { windowsHide: true });
    } catch (e) {
      releaseVmSlot();
      throw new Error(`failed to launch WSL: ${String(e)}`);
    }

    const session: VmSession = {
      key,
      child,
      startedAt: Date.now(),
      stderr: "",
      exited: false,
    };
    sessions.set(key, session);

    child.stderr?.on("data", (d) => {
      if (session.stderr.length < 8000) session.stderr += d.toString();
    });
    child.on("error", (err) => {
      session.stderr += `\n${String(err)}`;
      session.exited = true;
    });
    child.on("close", () => {
      session.exited = true;
      if (sessions.get(key) === session) sessions.delete(key);
      releaseVmSlot();
    });

    try {
      await this.waitForDaemon(conversationId, session);
      return session;
    } catch (e) {
      this.killSession(conversationId);
      throw e;
    }
  }

  private killSession(conversationId: string): boolean {
    const key = safeConvId(conversationId);
    // Stop ONLY this conversation's VM, surgically, via the bridge. We must NOT
    // kill the wsl.exe relay (session.child) for VM lifecycle: it's just an I/O
    // bridge into the single shared WSL2 instance, so killing wsl-side processes
    // to "stop a VM" is both pointless (the Linux cloud-hypervisor keeps running)
    // and dangerous. `llm-vm-run stop <key>` kills exactly this conversation's
    // cloud-hypervisor (matched by its unique sys.img path) and frees its
    // tap/virtiofsd/slot; the foreground bridge then returns and its relay exits
    // on its own (firing the child 'close' handler that releases the VM slot).
    // Keying off the conversation — not the in-memory session map — also lets us
    // stop VMs orphaned by a Node restart.
    this.stopVmInWsl(key);
    const session = sessions.get(key);
    if (session) {
      session.exited = true;
      sessions.delete(key);
    }
    return !!session;
  }

  /**
   * Ask the privileged bridge to terminate this conversation's VM in WSL
   * (`llm-vm-run stop <key>`): kills cloud-hypervisor + virtiofsd and frees the
   * tap/IP slot. Synchronous and best-effort so deleteSandbox can safely remove
   * the workspace dir afterwards.
   */
  private stopVmInWsl(key: string): void {
    try {
      spawnSync(
        "wsl.exe",
        [
          "-d",
          this.cfg.wslDistro,
          "--",
          "sudo",
          "-n",
          "/usr/local/sbin/llm-vm-run",
          "stop",
          key,
        ],
        { windowsHide: true, timeout: 20000 },
      );
    } catch {
      /* best-effort */
    }
  }

  private async daemonReady(conversationId: string): Promise<boolean> {
    try {
      const p = path.win32.join(
        this.workspaceHostPath(conversationId),
        ".run",
        "daemon.json",
      );
      const d = JSON.parse(await fs.promises.readFile(p, "utf-8")) as {
        status?: string;
      };
      return d.status === "running";
    } catch {
      return false;
    }
  }

  private async waitForDaemon(
    conversationId: string,
    session: VmSession,
  ): Promise<void> {
    const deadline = Date.now() + 90_000;
    while (Date.now() < deadline) {
      if (session.exited) {
        throw new Error(
          `microVM exited before daemon was ready${session.stderr ? `: ${session.stderr.slice(-1000)}` : ""}`,
        );
      }
      if (await this.daemonReady(conversationId)) return;
      await this.sleep(250);
    }
    throw new Error("microVM daemon did not become ready");
  }

  private async waitForJob(
    conversationId: string,
    jobId: string,
    start: number,
    timeoutMs: number,
    cap: number,
  ): Promise<RunResult> {
    const dir = this.workspaceHostPath(conversationId);
    const jobDir = path.win32.join(dir, ".run", "jobs", jobId);
    const resultPath = path.win32.join(jobDir, "result.json");
    const statusPath = path.win32.join(jobDir, "status.json");
    const waitDeadline = Date.now() + timeoutMs + 60_000;

    while (Date.now() < waitDeadline) {
      try {
        const out = JSON.parse(
          await fs.promises.readFile(resultPath, "utf-8"),
        ) as {
          stdout?: string;
          stderr?: string;
          exitCode?: number | null;
          durationMs?: number;
          timedOut?: boolean;
          status?: RunResult["status"];
        };
        return {
          stdout: (out.stdout ?? "").slice(0, cap),
          stderr: (out.stderr ?? "").slice(0, cap),
          exitCode: out.exitCode ?? null,
          durationMs: out.durationMs ?? Date.now() - start,
          timedOut: Boolean(out.timedOut),
          status: out.status,
          files: await listFiles(dir, start),
        };
      } catch {
        /* not done yet */
      }
      const session = sessions.get(safeConvId(conversationId));
      if (!session || session.exited) {
        const status = await this.tail(statusPath, 1000);
        return emptyResult({
          error: `microVM session exited before job completed${status ? `; status: ${status}` : ""}`,
          durationMs: Date.now() - start,
        });
      }
      await this.sleep(250);
    }

    this.killRun(conversationId, jobId);
    return emptyResult({
      error: "microVM job exceeded host wait limit",
      timedOut: true,
      durationMs: Date.now() - start,
    });
  }

  private async writeJsonAtomic(file: string, obj: unknown): Promise<void> {
    const tmp = `${file}.tmp-${nanoid(6)}`;
    await fs.promises.writeFile(tmp, JSON.stringify(obj));
    await fs.promises.rename(tmp, file);
  }

  private sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }

  private async tail(file: string, chars: number): Promise<string> {
    try {
      const s = await fs.promises.readFile(file, "utf-8");
      return s.slice(-chars);
    } catch {
      return "";
    }
  }
}
