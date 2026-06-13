"use client";

/**
 * Text-to-speech: prefers xAI cloud TTS (/api/tts, natural voices), falls back
 * to the browser's offline Web Speech API if the cloud is unavailable.
 */

let currentAudio: HTMLAudioElement | null = null;

export function ttsSupported(): boolean {
  return typeof window !== "undefined";
}

function browserSupported(): boolean {
  return typeof window !== "undefined" && "speechSynthesis" in window;
}

function guessLang(text: string): string {
  if (/[一-鿿]/.test(text)) return "zh-TW";
  if (/[぀-ヿ]/.test(text)) return "ja-JP";
  if (/[가-힯]/.test(text)) return "ko-KR";
  return typeof navigator !== "undefined" ? navigator.language : "en-US";
}

interface SpeakOpts {
  onStart?: () => void;
  onEnd?: () => void;
}

function browserSpeak(text: string, opts: SpeakOpts): void {
  if (!browserSupported()) {
    opts.onEnd?.();
    return;
  }
  window.speechSynthesis.cancel();
  const u = new SpeechSynthesisUtterance(text);
  u.lang = guessLang(text);
  u.onstart = () => opts.onStart?.();
  u.onend = () => opts.onEnd?.();
  u.onerror = () => opts.onEnd?.();
  window.speechSynthesis.speak(u);
}

export async function speak(text: string, opts: SpeakOpts = {}): Promise<void> {
  if (!text.trim()) return;
  stopSpeaking();
  try {
    const res = await fetch("/api/tts", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ text }),
    });
    if (res.ok) {
      const blob = await res.blob();
      const url = URL.createObjectURL(blob);
      const audio = new Audio(url);
      currentAudio = audio;
      audio.onended = () => {
        URL.revokeObjectURL(url);
        if (currentAudio === audio) currentAudio = null;
        opts.onEnd?.();
      };
      audio.onerror = () => {
        URL.revokeObjectURL(url);
        opts.onEnd?.();
      };
      await audio.play();
      opts.onStart?.();
      return;
    }
  } catch {
    /* fall through to browser TTS */
  }
  browserSpeak(text, opts);
}

export function stopSpeaking(): void {
  if (currentAudio) {
    currentAudio.pause();
    currentAudio = null;
  }
  if (browserSupported()) window.speechSynthesis.cancel();
}
