"use client";

import { useEffect, useState } from "react";
import { X, ChevronRight, Sparkles, Loader2 } from "lucide-react";
import { fetchSkills, type SkillInfo } from "@/lib/api";
import { Markdown } from "./Markdown";

/** Browse the installed skills (name, description, full playbook). */
export function SkillsModal({
  open,
  onClose,
}: {
  open: boolean;
  onClose: () => void;
}) {
  const [skills, setSkills] = useState<SkillInfo[] | null>(null);
  const [expanded, setExpanded] = useState<string | null>(null);

  useEffect(() => {
    if (!open) return;
    setSkills(null);
    setExpanded(null);
    fetchSkills().then(setSkills);
  }, [open]);

  if (!open) return null;

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4"
      onClick={onClose}
    >
      <div
        className="flex max-h-[88dvh] w-full max-w-2xl flex-col overflow-hidden rounded-2xl border border-border bg-surface shadow-xl"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center justify-between border-b border-border px-5 py-3">
          <h2 className="flex items-center gap-2 text-sm font-semibold">
            <Sparkles size={16} className="text-accent" />
            技能 Skills{skills ? ` (${skills.length})` : ""}
          </h2>
          <button onClick={onClose} className="text-muted hover:text-foreground">
            <X size={18} />
          </button>
        </div>

        <div className="min-h-0 flex-1 overflow-y-auto px-4 py-3">
          {skills === null ? (
            <div className="flex items-center gap-2 py-10 text-sm text-muted">
              <Loader2 size={14} className="animate-spin" /> 載入中…
            </div>
          ) : skills.length === 0 ? (
            <p className="py-10 text-center text-xs text-muted">
              還沒有技能。把技能資料夾放進 skills/，或讓模型用 install_skill 安裝。
            </p>
          ) : (
            <ul className="space-y-2">
              {skills.map((s) => {
                const isOpen = expanded === s.name;
                return (
                  <li
                    key={s.name}
                    className="overflow-hidden rounded-xl border border-border bg-surface-2"
                  >
                    <button
                      onClick={() => setExpanded(isOpen ? null : s.name)}
                      className="flex w-full items-start gap-2 px-4 py-3 text-left"
                    >
                      <ChevronRight
                        size={15}
                        className={`mt-0.5 shrink-0 text-muted transition-transform ${
                          isOpen ? "rotate-90" : ""
                        }`}
                      />
                      <div className="min-w-0 flex-1">
                        <div className="font-mono text-sm font-medium text-foreground">
                          {s.name}
                        </div>
                        <div className="mt-0.5 text-xs leading-relaxed text-muted">
                          {s.description}
                        </div>
                      </div>
                    </button>
                    {isOpen && (
                      <div className="border-t border-border px-4 py-3 text-sm">
                        <Markdown>{s.body || "_(no details)_"}</Markdown>
                      </div>
                    )}
                  </li>
                );
              })}
            </ul>
          )}
        </div>

        <div className="border-t border-border px-5 py-2 text-[11px] text-muted">
          技能需在啟用沙盒時生效；模型符合任務時會自動載入對應技能。
        </div>
      </div>
    </div>
  );
}
