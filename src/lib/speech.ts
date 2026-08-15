// Pronunciation goes through the platform's own speech synthesis: no audio files, no
// network, and on the phone it is the same voice engine the OS uses everywhere else,
// so it keeps working offline.

// The vocabulary is English; the voice must not follow the UI or system locale.
const TERM_LANGUAGE = "en-US";

// Chromium truncates speech whose utterance gets garbage-collected mid-synthesis
// (crbug 41084789); the one currently playing is pinned here until it ends.
let pinnedUtterance: SpeechSynthesisUtterance | null = null;

export function speechAvailable(): boolean {
  if (typeof window === "undefined") {
    return false;
  }
  // `"speechSynthesis" in window` would pass a present-but-undefined property, and the
  // resulting crash would land in an effect cleanup that every card change runs.
  return (
    window.speechSynthesis !== undefined &&
    window.speechSynthesis !== null &&
    typeof SpeechSynthesisUtterance === "function"
  );
}

export function pronounce(term: string): void {
  if (!speechAvailable()) {
    return;
  }

  const utterance = new SpeechSynthesisUtterance(term);
  utterance.lang = TERM_LANGUAGE;
  utterance.onend = () => {
    if (pinnedUtterance === utterance) {
      pinnedUtterance = null;
    }
  };
  pinnedUtterance = utterance;

  // Tapping again while the previous word is still playing restarts it; nothing queues.
  // cancel() straight before speak() can swallow the new utterance in some engines
  // (Mozilla bug 1522074), so it only runs when something is actually in flight.
  if (window.speechSynthesis.speaking || window.speechSynthesis.pending) {
    window.speechSynthesis.cancel();
  }
  window.speechSynthesis.speak(utterance);
}

export function stopPronunciation(): void {
  if (speechAvailable()) {
    window.speechSynthesis.cancel();
  }
}
