"use client";

import { useEffect, useState } from "react";
import { fetchHealth, type HealthStatus } from "@/lib/api";

export function ConnectionStatus() {
  const [health, setHealth] = useState<HealthStatus | null>(null);

  useEffect(() => {
    let active = true;
    const check = async () => {
      const h = await fetchHealth();
      if (active) setHealth(h);
    };
    check();
    const id = setInterval(check, 15000);
    return () => {
      active = false;
      clearInterval(id);
    };
  }, []);

  const state = health == null ? "checking" : health.ok ? "online" : "offline";
  const color =
    state === "online"
      ? "bg-emerald-500"
      : state === "offline"
        ? "bg-red-500"
        : "bg-amber-400";

  const label =
    state === "online"
      ? health?.chatLoaded
        ? health.chatModel
        : `connected · "${health?.chatModel}" not loaded`
      : state === "offline"
        ? "LM Studio offline"
        : "checking…";

  return (
    <div
      className="flex shrink-0 items-center gap-1.5 text-xs text-muted"
      title={
        health?.ok
          ? `Loaded: ${health.models?.join(", ") || "none"}`
          : health?.error || "Checking local model server…"
      }
    >
      <span className={`h-2 w-2 rounded-full ${color}`} />
      <span className="max-w-[200px] truncate">{label}</span>
    </div>
  );
}
