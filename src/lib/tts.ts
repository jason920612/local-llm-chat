"use client";

/** Text-to-speech via the browser's Web Speech API (uses offline OS voices). */

export function ttsSupported(): boolean {
  return typeof window !== "undefined" && "speechSynthesis" in window;
}

function guessLang(text: string): string {
  if (/[一-鿿]/.test(text)) return "zh-TW";
  if (/[぀-ヿ]/.test(text)) return "ja-JP";
  if (/[가-힯]/.test(text)) return "ko-KR";
  return typeof navigator !== "undefined" ? navigator.language : "en-US";
}

export function speak(text: string, onEnd?: () => void): void {
  if (!ttsSupported() || !text.trim()) return;
  window.speechSynthesis.cancel();
  const u = new SpeechSynthesisUtterance(text);
  u.lang = guessLang(text);
  u.onend = () => onEnd?.();
  u.onerror = () => onEnd?.();
  window.speechSynthesis.speak(u);
}

export function stopSpeaking(): void {
  if (ttsSupported()) window.speechSynthesis.cancel();
}
