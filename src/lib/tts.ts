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

function browserSpeak(text: string, onEnd?: () => void): void {
  if (!browserSupported()) {
    onEnd?.();
    return;
  }
  window.speechSynthesis.cancel();
  const u = new SpeechSynthesisUtterance(text);
  u.lang = guessLang(text);
  u.onend = () => onEnd?.();
  u.onerror = () => onEnd?.();
  window.speechSynthesis.speak(u);
}

export async function speak(text: string, onEnd?: () => void): Promise<void> {
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
        onEnd?.();
      };
      audio.onerror = () => {
        URL.revokeObjectURL(url);
        onEnd?.();
      };
      await audio.play();
      return;
    }
  } catch {
    /* fall through to browser TTS */
  }
  browserSpeak(text, onEnd);
}

export function stopSpeaking(): void {
  if (currentAudio) {
    currentAudio.pause();
    currentAudio = null;
  }
  if (browserSupported()) window.speechSynthesis.cancel();
}
