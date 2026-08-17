// Pronunciation goes through the platform's own speech synthesis: no audio files, no
// network, and on the phone it is the same voice engine the OS uses everywhere else,
// so it keeps working offline. Only local voices are ever selected — remote ones (Edge
// "Online (Natural)", Chrome's "Google US English") would go silent offline, and a
// platform with no local English at all is left to the engine default, which is what
// served before ranking existed.

// The vocabulary is English; the voice must not follow the UI or system locale.
const TERM_LANGUAGE = "en-US";

// Setting only `lang` leaves the voice choice to the engine, and several engines answer
// with their oldest formant voice — the robotic one. Apple's downloadable
// "Premium"/"Enhanced" voices are near-human, and Samantha is the best of the set
// macOS/iOS always ship. Apple marks quality in the voiceURI
// (com.apple.voice.premium.en-US.Ava) while the name is just "Ava", so both fields are
// matched.
const VOICE_QUALITY_MARKERS: readonly RegExp[] = [
  /premium/i,
  /enhanced/i,
  /samantha/i,
];

// The slice of SpeechSynthesisVoice the ranking reads; tests build these as plain
// objects instead of stubbing the real class.
export type VoiceCandidate = Pick<
  SpeechSynthesisVoice,
  "name" | "lang" | "voiceURI" | "default" | "localService"
>;

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

// Chromium fills the voice list asynchronously and only starts loading it after the
// first getVoices() call; asking once at mount means the list has real voices to rank
// by the time the first card is tapped. A plain function, not part of speechAvailable:
// that one doubles as a useSyncExternalStore snapshot getter and must stay pure.
export function warmUpVoices(): void {
  if (speechAvailable()) {
    listVoices();
  }
}

// Sloppy Android engines have shipped voices without a lang; "" keeps them out of the
// candidate set instead of crashing a click handler. Android also reports "en_US".
function normalizedLanguage(voice: VoiceCandidate): string {
  return typeof voice.lang === "string"
    ? voice.lang.toLowerCase().replace("_", "-")
    : "";
}

function qualityRank(voice: VoiceCandidate): number {
  const rank = VOICE_QUALITY_MARKERS.findIndex(
    (marker) => marker.test(voice.name) || marker.test(voice.voiceURI),
  );
  return rank === -1 ? VOICE_QUALITY_MARKERS.length : rank;
}

function outranks(voice: VoiceCandidate, incumbent: VoiceCandidate): boolean {
  const byQuality = qualityRank(voice) - qualityRank(incumbent);
  if (byQuality !== 0) {
    return byQuality < 0;
  }
  const american = normalizedLanguage(voice).startsWith("en-us");
  if (american !== normalizedLanguage(incumbent).startsWith("en-us")) {
    return american;
  }
  // The engine's own default is the voice the platform tuned; a later duplicate is not.
  if (voice.default !== incumbent.default) {
    return voice.default;
  }
  return false;
}

export function bestEnglishVoice<Voice extends VoiceCandidate>(
  voices: readonly Voice[],
): Voice | null {
  let best: Voice | null = null;
  for (const voice of voices) {
    if (!normalizedLanguage(voice).startsWith("en")) {
      continue;
    }
    // An engine too sloppy to report localService is assumed local — assuming remote
    // would rule out every voice on such a platform.
    if (voice.localService === false) {
      continue;
    }
    if (best === null || outranks(voice, best)) {
      best = voice;
    }
  }
  return best;
}

// Queried on every pronounce rather than cached: the list changes when the platform
// finishes loading voices or the user installs one, and voiceschanged is unreliable
// across engines.
function listVoices(): SpeechSynthesisVoice[] {
  const synthesis = window.speechSynthesis;
  return typeof synthesis.getVoices === "function" ? synthesis.getVoices() : [];
}

export function pronounce(term: string): void {
  if (!speechAvailable()) {
    return;
  }
  speak(term, bestEnglishVoice(listVoices()));
}

function speak(term: string, voice: SpeechSynthesisVoice | null): void {
  const utterance = new SpeechSynthesisUtterance(term);
  if (voice === null) {
    utterance.lang = TERM_LANGUAGE;
  } else {
    utterance.voice = voice;
    // A voice paired with a lang it does not speak is unspecified territory, and
    // engines disagree on which of the two wins; keeping them identical sidesteps it.
    utterance.lang = voice.lang;
  }
  utterance.onend = () => {
    if (pinnedUtterance === utterance) {
      pinnedUtterance = null;
    }
  };
  // A chosen voice can still fail to produce audio — say, a Premium voice whose
  // downloaded asset is gone. The engine default that served before ranking existed is
  // the fallback; a fallback utterance carries no voice, so two dead voices cannot
  // loop. Two more ways an error must stay silent: cancel() lands here too
  // ("canceled"/"interrupted"), and a slow failure can arrive after the card changed —
  // both would resurrect a word the app already moved past, so the retry also requires
  // that this utterance is still the pinned (current) one.
  utterance.onerror = (event) => {
    const wasCurrent = pinnedUtterance === utterance;
    if (wasCurrent) {
      pinnedUtterance = null;
    }
    if (
      wasCurrent &&
      voice !== null &&
      event.error !== "canceled" &&
      event.error !== "interrupted"
    ) {
      speak(term, null);
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
    // Nothing survives a cancel, so nothing needs pinning — and an utterance whose
    // cancellation surfaces as a late error (or as nothing at all, on WebKit) must
    // already read as "not current" by the time that error runs.
    pinnedUtterance = null;
    window.speechSynthesis.cancel();
  }
}
