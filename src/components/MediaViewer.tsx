"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import {
  Play,
  Pause,
  Volume2,
  VolumeX,
  Maximize,
  Minimize,
  ZoomIn,
  ZoomOut,
  RotateCcw,
  Download,
  Music,
  RotateCw,
} from "lucide-react";

const clamp = (v: number, lo: number, hi: number) =>
  Math.max(lo, Math.min(hi, v));

function fmtTime(s: number): string {
  if (!isFinite(s) || s < 0) s = 0;
  const m = Math.floor(s / 60);
  const sec = Math.floor(s % 60);
  return `${m}:${sec.toString().padStart(2, "0")}`;
}

/** A themed, draggable seek/volume bar (0..1). */
function Scrubber({
  value,
  buffered,
  onSeek,
  className = "",
}: {
  value: number;
  buffered?: number;
  onSeek: (frac: number) => void;
  className?: string;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const dragging = useRef(false);
  const at = (clientX: number) => {
    const r = ref.current?.getBoundingClientRect();
    if (!r || r.width === 0) return;
    onSeek(clamp((clientX - r.left) / r.width, 0, 1));
  };
  return (
    <div
      ref={ref}
      className={`group/scrub relative h-1.5 cursor-pointer rounded-full bg-white/15 ${className}`}
      onPointerDown={(e) => {
        dragging.current = true;
        e.currentTarget.setPointerCapture(e.pointerId);
        at(e.clientX);
      }}
      onPointerMove={(e) => dragging.current && at(e.clientX)}
      onPointerUp={(e) => {
        dragging.current = false;
        e.currentTarget.releasePointerCapture(e.pointerId);
      }}
    >
      {buffered != null && (
        <div
          className="absolute inset-y-0 left-0 rounded-full bg-white/25"
          style={{ width: `${buffered * 100}%` }}
        />
      )}
      <div
        className="absolute inset-y-0 left-0 rounded-full bg-accent"
        style={{ width: `${value * 100}%` }}
      />
      <div
        className="absolute top-1/2 h-3 w-3 -translate-x-1/2 -translate-y-1/2 rounded-full bg-accent opacity-0 shadow transition group-hover/scrub:opacity-100"
        style={{ left: `${value * 100}%` }}
      />
    </div>
  );
}

const RATES = [1, 1.25, 1.5, 2];

/* ----------------------------- Image viewer ----------------------------- */

export function ImageViewer({ src, alt }: { src: string; alt?: string }) {
  const box = useRef<HTMLDivElement>(null);
  const [scale, setScale] = useState(1);
  const [tx, setTx] = useState(0);
  const [ty, setTy] = useState(0);
  const drag = useRef<{ x: number; y: number } | null>(null);

  const reset = useCallback(() => {
    setScale(1);
    setTx(0);
    setTy(0);
  }, []);

  // Zoom toward a point (container-center-relative coords).
  const zoomTo = useCallback(
    (factor: number, cx = 0, cy = 0) => {
      setScale((s) => {
        const ns = clamp(s * factor, 1, 8);
        const ratio = ns / s;
        if (ns === 1) {
          setTx(0);
          setTy(0);
        } else {
          setTx((p) => cx - ratio * (cx - p));
          setTy((p) => cy - ratio * (cy - p));
        }
        return ns;
      });
    },
    [],
  );

  const onWheel = (e: React.WheelEvent) => {
    e.preventDefault();
    const r = box.current?.getBoundingClientRect();
    if (!r) return;
    zoomTo(
      e.deltaY < 0 ? 1.15 : 1 / 1.15,
      e.clientX - r.left - r.width / 2,
      e.clientY - r.top - r.height / 2,
    );
  };

  return (
    <div className="relative">
      <div
        ref={box}
        onWheel={onWheel}
        onDoubleClick={() => (scale === 1 ? zoomTo(2.2) : reset())}
        onPointerDown={(e) => {
          if (scale === 1) return;
          drag.current = { x: e.clientX - tx, y: e.clientY - ty };
          e.currentTarget.setPointerCapture(e.pointerId);
        }}
        onPointerMove={(e) => {
          if (!drag.current) return;
          setTx(e.clientX - drag.current.x);
          setTy(e.clientY - drag.current.y);
        }}
        onPointerUp={() => (drag.current = null)}
        className="flex h-[78vh] items-center justify-center overflow-hidden bg-[#0b0c10]"
        style={{ cursor: scale > 1 ? "grab" : "zoom-in" }}
      >
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img
          src={src}
          alt={alt ?? ""}
          draggable={false}
          className="max-h-full max-w-full select-none"
          style={{
            transform: `translate(${tx}px, ${ty}px) scale(${scale})`,
            transition: drag.current ? "none" : "transform .08s ease-out",
          }}
        />
      </div>
      <div className="absolute bottom-3 left-1/2 flex -translate-x-1/2 items-center gap-1 rounded-full border border-border bg-surface/90 px-2 py-1 backdrop-blur">
        <CtrlBtn onClick={() => zoomTo(1 / 1.3)} title="縮小">
          <ZoomOut size={15} />
        </CtrlBtn>
        <span className="w-12 text-center text-xs tabular-nums text-muted">
          {Math.round(scale * 100)}%
        </span>
        <CtrlBtn onClick={() => zoomTo(1.3)} title="放大">
          <ZoomIn size={15} />
        </CtrlBtn>
        <CtrlBtn onClick={reset} title="重設">
          <RotateCcw size={15} />
        </CtrlBtn>
        <a
          href={src}
          download
          className="flex h-7 w-7 items-center justify-center rounded-full text-muted hover:bg-surface-2 hover:text-foreground"
          title="下載"
        >
          <Download size={15} />
        </a>
      </div>
    </div>
  );
}

function CtrlBtn({
  onClick,
  title,
  children,
}: {
  onClick: () => void;
  title: string;
  children: React.ReactNode;
}) {
  return (
    <button
      onClick={onClick}
      title={title}
      className="flex h-7 w-7 items-center justify-center rounded-full text-muted hover:bg-surface-2 hover:text-foreground"
    >
      {children}
    </button>
  );
}

/* ----------------------------- Audio player ----------------------------- */

export function AudioPlayer({ src, name }: { src: string; name?: string }) {
  const a = useRef<HTMLAudioElement>(null);
  const [playing, setPlaying] = useState(false);
  const [cur, setCur] = useState(0);
  const [dur, setDur] = useState(0);
  const [vol, setVol] = useState(1);
  const [muted, setMuted] = useState(false);
  const [rate, setRate] = useState(1);

  const toggle = () => {
    const el = a.current;
    if (!el) return;
    if (el.paused) el.play();
    else el.pause();
  };
  const cycleRate = () => {
    const next = RATES[(RATES.indexOf(rate) + 1) % RATES.length];
    setRate(next);
    if (a.current) a.current.playbackRate = next;
  };

  return (
    <div className="p-6">
      <div className="mx-auto max-w-xl rounded-2xl border border-border bg-surface-2 p-5">
        <div className="mb-4 flex items-center gap-3">
          <div className="flex h-12 w-12 shrink-0 items-center justify-center rounded-xl bg-accent/15 text-accent">
            <Music size={22} className={playing ? "animate-pulse" : ""} />
          </div>
          <div className="min-w-0">
            <div className="truncate text-sm font-medium">{name ?? "Audio"}</div>
            <div className="text-xs tabular-nums text-muted">
              {fmtTime(cur)} / {fmtTime(dur)}
            </div>
          </div>
        </div>

        <Scrubber
          value={dur ? cur / dur : 0}
          onSeek={(f) => {
            if (a.current && dur) a.current.currentTime = f * dur;
          }}
        />

        <div className="mt-4 flex items-center gap-3">
          <button
            onClick={toggle}
            className="flex h-11 w-11 items-center justify-center rounded-full bg-accent-strong text-white hover:bg-accent"
            title={playing ? "暫停" : "播放"}
          >
            {playing ? <Pause size={20} /> : <Play size={20} className="ml-0.5" />}
          </button>
          <button
            onClick={() => {
              setMuted((m) => {
                if (a.current) a.current.muted = !m;
                return !m;
              });
            }}
            className="text-muted hover:text-foreground"
            title={muted ? "取消靜音" : "靜音"}
          >
            {muted || vol === 0 ? <VolumeX size={18} /> : <Volume2 size={18} />}
          </button>
          <Scrubber
            className="w-24"
            value={muted ? 0 : vol}
            onSeek={(f) => {
              setVol(f);
              setMuted(false);
              if (a.current) {
                a.current.volume = f;
                a.current.muted = false;
              }
            }}
          />
          <button
            onClick={cycleRate}
            className="ml-auto rounded-md border border-border px-2 py-0.5 text-xs text-muted hover:text-foreground"
            title="播放速度"
          >
            {rate}×
          </button>
        </div>
      </div>

      <audio
        ref={a}
        src={src}
        onPlay={() => setPlaying(true)}
        onPause={() => setPlaying(false)}
        onTimeUpdate={(e) => setCur(e.currentTarget.currentTime)}
        onLoadedMetadata={(e) => setDur(e.currentTarget.duration)}
        onEnded={() => setPlaying(false)}
      />
    </div>
  );
}

/* ----------------------------- Video player ----------------------------- */

export function VideoPlayer({
  src,
  inline = false,
}: {
  src: string;
  inline?: boolean;
}) {
  const wrap = useRef<HTMLDivElement>(null);
  const v = useRef<HTMLVideoElement>(null);
  const [playing, setPlaying] = useState(false);
  const [cur, setCur] = useState(0);
  const [dur, setDur] = useState(0);
  const [buffered, setBuffered] = useState(0);
  const [vol, setVol] = useState(1);
  const [muted, setMuted] = useState(false);
  const [rate, setRate] = useState(1);
  const [full, setFull] = useState(false);
  const [showCtrl, setShowCtrl] = useState(true);
  const hideTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const toggle = () => {
    const el = v.current;
    if (!el) return;
    if (el.paused) el.play();
    else el.pause();
  };
  const seekBy = (d: number) => {
    if (v.current) v.current.currentTime = clamp(v.current.currentTime + d, 0, dur);
  };
  const cycleRate = () => {
    const next = RATES[(RATES.indexOf(rate) + 1) % RATES.length];
    setRate(next);
    if (v.current) v.current.playbackRate = next;
  };
  const toggleFull = () => {
    if (!document.fullscreenElement) wrap.current?.requestFullscreen?.();
    else document.exitFullscreen?.();
  };

  useEffect(() => {
    const onFs = () => setFull(Boolean(document.fullscreenElement));
    document.addEventListener("fullscreenchange", onFs);
    return () => document.removeEventListener("fullscreenchange", onFs);
  }, []);

  const nudge = () => {
    setShowCtrl(true);
    if (hideTimer.current) clearTimeout(hideTimer.current);
    hideTimer.current = setTimeout(() => {
      if (!v.current?.paused) setShowCtrl(false);
    }, 2200);
  };

  return (
    <div
      ref={wrap}
      className={`relative flex items-center justify-center bg-black ${
        inline ? "overflow-hidden rounded-lg border border-border" : ""
      }`}
      onMouseMove={nudge}
      onMouseLeave={() => !v.current?.paused && setShowCtrl(false)}
    >
      <video
        ref={v}
        src={src}
        onClick={toggle}
        onPlay={() => setPlaying(true)}
        onPause={() => {
          setPlaying(false);
          setShowCtrl(true);
        }}
        onTimeUpdate={(e) => {
          setCur(e.currentTarget.currentTime);
          const b = e.currentTarget.buffered;
          if (b.length) setBuffered(b.end(b.length - 1));
        }}
        onLoadedMetadata={(e) => setDur(e.currentTarget.duration)}
        onEnded={() => setPlaying(false)}
        className={`w-full ${
          full ? "max-h-screen" : inline ? "max-h-72" : "max-h-[78vh]"
        }`}
      />

      {/* Center play overlay when paused */}
      {!playing && (
        <button
          onClick={toggle}
          className="absolute inset-0 flex items-center justify-center"
          title="播放"
        >
          <span className="flex h-16 w-16 items-center justify-center rounded-full bg-black/55 text-white backdrop-blur">
            <Play size={30} className="ml-1" />
          </span>
        </button>
      )}

      {/* Control bar */}
      <div
        className={`absolute inset-x-0 bottom-0 bg-gradient-to-t from-black/80 to-transparent px-3 pb-2 pt-6 transition-opacity ${
          showCtrl || !playing ? "opacity-100" : "opacity-0"
        }`}
      >
        <Scrubber
          value={dur ? cur / dur : 0}
          buffered={dur ? buffered / dur : 0}
          onSeek={(f) => {
            if (v.current && dur) v.current.currentTime = f * dur;
          }}
        />
        <div className="mt-2 flex items-center gap-3 text-white">
          <button onClick={toggle} title={playing ? "暫停" : "播放"}>
            {playing ? <Pause size={18} /> : <Play size={18} />}
          </button>
          <button onClick={() => seekBy(-10)} title="後退 10 秒">
            <RotateCcw size={16} />
          </button>
          <button onClick={() => seekBy(10)} title="前進 10 秒">
            <RotateCw size={16} />
          </button>
          <button
            onClick={() => {
              setMuted((m) => {
                if (v.current) v.current.muted = !m;
                return !m;
              });
            }}
            title={muted ? "取消靜音" : "靜音"}
          >
            {muted || vol === 0 ? <VolumeX size={18} /> : <Volume2 size={18} />}
          </button>
          <Scrubber
            className="w-20"
            value={muted ? 0 : vol}
            onSeek={(f) => {
              setVol(f);
              setMuted(false);
              if (v.current) {
                v.current.volume = f;
                v.current.muted = false;
              }
            }}
          />
          <span className="text-xs tabular-nums">
            {fmtTime(cur)} / {fmtTime(dur)}
          </span>
          <button
            onClick={cycleRate}
            className="ml-auto rounded border border-white/30 px-1.5 text-xs"
            title="播放速度"
          >
            {rate}×
          </button>
          <button onClick={toggleFull} title="全螢幕">
            {full ? <Minimize size={18} /> : <Maximize size={18} />}
          </button>
        </div>
      </div>
    </div>
  );
}
