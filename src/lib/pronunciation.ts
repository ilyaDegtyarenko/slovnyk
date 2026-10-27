import { z } from "zod";
import {
  pronounce as speakWithSystemVoice,
  speechAvailable,
  stopPronunciation as stopSystemVoice,
} from "@/lib/speech";

// A term is pronounced from a recorded MP3 — synthesized once on the server, then kept on
// the device — rather than by the platform's speech synthesis: iOS mutes speechSynthesis
// whenever the phone is in Silent Mode, which for many people is always, while an
// <audio> element plays regardless. The platform voice stays as the fallback for a term
// whose file is not on the device yet.

// One voice for the whole vocabulary. It is part of every stored file's key, so changing
// it here re-records the list (the old files are pruned) instead of mixing two voices.
export const PRONUNCIATION_VOICE = {
  languageCode: "en-US",
  name: "en-US-Chirp3-HD-Kore",
} as const;

const PRONUNCIATION_PATH = "/api/pronounce";

const CACHE_NAME = "slovnyk-pronunciations";

// Later loads of the same term join a download in flight, so one that never settles would
// keep that term silent until the page is reloaded.
const DOWNLOAD_TIMEOUT_MS = 20_000;

// Answers after which every further download in the same pass would fail the same way:
// the device's access key is stale (401), or the server has no Text-to-Speech key (503).
const BLOCKING_STATUSES = new Set([401, 503]);

// Failures in a row after which the rest of a pass would most likely fail the same way —
// a key Google refuses, a spent quota, or an unreachable sheet fails every word. Not one:
// a single word Google cannot say must not keep the words after it off the device.
const FAILURES_BEFORE_GIVING_UP = 3;

// The one claim about the bytes that can be checked before they play.
const AudioContentType = z.string().startsWith("audio/");

export type LoadedPronunciation =
  | { ok: true; audio: Blob }
  // `blocked`: nothing else will download in this pass either — offline, locked, or not
  // configured — so a prefetch stops instead of failing word after word.
  | { ok: false; blocked: boolean };

export function pronunciationEndpoint(term: string): string {
  return `${PRONUNCIATION_PATH}?term=${encodeURIComponent(term)}`;
}

// The key a file is stored under: never fetched, only matched.
export function pronunciationCacheKey(term: string): string {
  return `/pronunciations/${PRONUNCIATION_VOICE.name}/${encodeURIComponent(term)}`;
}

const downloads = new Map<string, Promise<LoadedPronunciation>>();

// The file for the card on screen, ready as an object URL: on iOS, play() must start
// inside the tap itself, so there is no time left to read a cache once the tap lands.
let prepared: { term: string; url: string } | null = null;

let player: HTMLAudioElement | null = null;

// Bumped by every stop, so a playback failure that surfaces after the card moved on
// cannot make the system voice read the old word over the new one.
let playbackGeneration = 0;

export function pronunciationAvailable(): boolean {
  if (typeof window === "undefined") {
    return false;
  }
  return typeof Audio === "function" || speechAvailable();
}

async function openPronunciationCache(): Promise<Cache | null> {
  // Cache Storage exists only in secure contexts — a phone on a LAN dev server has none,
  // and then every tap downloads afresh.
  if (typeof caches === "undefined") {
    return null;
  }
  try {
    return await caches.open(CACHE_NAME);
  } catch {
    return null;
  }
}

export async function loadPronunciation(term: string): Promise<LoadedPronunciation> {
  const key = pronunciationCacheKey(term);
  const cache = await openPronunciationCache();
  if (cache !== null) {
    try {
      const stored = await cache.match(key);
      if (stored !== undefined) {
        return { ok: true, audio: await stored.blob() };
      }
    } catch {
      // An unreadable entry is a missing one; the download below replaces it.
    }
  }

  const running = downloads.get(key);
  if (running !== undefined) {
    return running;
  }
  const download = downloadPronunciation(term, key, cache).finally(() => {
    downloads.delete(key);
  });
  downloads.set(key, download);
  return download;
}

async function downloadPronunciation(
  term: string,
  key: string,
  cache: Cache | null,
): Promise<LoadedPronunciation> {
  let response: Response;
  try {
    response = await fetch(pronunciationEndpoint(term), {
      signal: AbortSignal.timeout(DOWNLOAD_TIMEOUT_MS),
    });
  } catch {
    return { ok: false, blocked: true };
  }

  if (!response.ok) {
    return { ok: false, blocked: BLOCKING_STATUSES.has(response.status) };
  }

  const contentType = AudioContentType.safeParse(response.headers.get("content-type"));
  if (!contentType.success) {
    return { ok: false, blocked: false };
  }

  let audio: Blob;
  try {
    audio = await response.blob();
  } catch {
    // The deadline covers the body too: a stall after the headers is the same dead
    // connection as one before them.
    return { ok: false, blocked: true };
  }
  if (audio.size === 0) {
    return { ok: false, blocked: false };
  }

  if (cache !== null) {
    try {
      await cache.put(
        key,
        new Response(audio, { headers: { "Content-Type": contentType.data } }),
      );
    } catch {
      // Out of storage: the word still plays this time and downloads again next time.
    }
  }
  return { ok: true, audio };
}

// Downloads every missing file one at a time — gentle on the quota, and the card on
// screen is prepared separately anyway — and drops files no current term or voice uses.
export async function prefetchPronunciations(terms: readonly string[]): Promise<void> {
  const wanted = [...new Set(terms)];
  // An empty list says more about the caller than about the vocabulary; wiping every file
  // on its word would cost a full re-download for nothing.
  if (wanted.length === 0) {
    return;
  }
  // A device that cannot keep files would download the whole list again on every visit,
  // for nothing it could play offline.
  const cache = await openPronunciationCache();
  if (cache === null) {
    return;
  }

  const stored = await pruneStoredPronunciations(cache, wanted);
  let failuresInARow = 0;
  for (const term of wanted) {
    if (stored.has(keyPath(pronunciationCacheKey(term)))) {
      continue;
    }
    const loaded = await loadPronunciation(term);
    if (loaded.ok) {
      failuresInARow = 0;
      continue;
    }
    failuresInARow += 1;
    if (loaded.blocked || failuresInARow === FAILURES_BEFORE_GIVING_UP) {
      return;
    }
  }
}

// Returns the paths of the files it kept, so the pass skips them without reading them.
async function pruneStoredPronunciations(
  cache: Cache,
  terms: readonly string[],
): Promise<Set<string>> {
  const keep = new Set(terms.map((term) => keyPath(pronunciationCacheKey(term))));
  const kept = new Set<string>();
  try {
    for (const request of await cache.keys()) {
      const storedPath = keyPath(request.url);
      if (keep.has(storedPath)) {
        kept.add(storedPath);
      } else {
        await cache.delete(request);
      }
    }
  } catch {
    // Pruning only reclaims space; a cache that refuses it keeps working, and the pass
    // then checks each term on its own.
  }
  return kept;
}

// Cache Storage hands keys back as absolute URLs; comparing paths makes them line up with
// the relative keys they were stored under.
function keyPath(url: string): string {
  return new URL(url, "https://slovnyk.invalid").pathname;
}

// Returns the effect cleanup: a card that has already moved on must not install its file.
export function preparePronunciation(term: string): () => void {
  let current = true;
  void loadPronunciation(term).then((loaded) => {
    if (!current || !loaded.ok) {
      return;
    }
    releasePrepared();
    prepared = { term, url: URL.createObjectURL(loaded.audio) };
  });
  return () => {
    current = false;
  };
}

function releasePrepared(): void {
  if (prepared !== null) {
    URL.revokeObjectURL(prepared.url);
    prepared = null;
  }
}

// One element for the whole page: WebKit lifts its playback restrictions on an element
// after the first tap-started play, which a fresh element per tap would never earn.
function audioPlayer(): HTMLAudioElement | null {
  if (player === null && typeof Audio === "function") {
    player = new Audio();
    player.preload = "auto";
  }
  return player;
}

export function pronounce(term: string): void {
  const url = prepared?.term === term ? prepared.url : null;
  const element = url === null ? null : audioPlayer();
  if (url === null || element === null) {
    speakWithSystemVoice(term);
    return;
  }

  stopSystemVoice();
  const generation = ++playbackGeneration;
  if (element.src !== url) {
    element.src = url;
  }
  // Tapping again while the word is still playing restarts it.
  element.currentTime = 0;
  element.play().catch((error: unknown) => {
    // AbortError is a pause() or a new source cutting this play short — a decision, not a
    // failure. Anything else (a refused or undecodable play) still owes the user a word.
    const aborted = error instanceof DOMException && error.name === "AbortError";
    if (!aborted && generation === playbackGeneration) {
      speakWithSystemVoice(term);
    }
  });
}

export function stopPronunciation(): void {
  playbackGeneration += 1;
  player?.pause();
  stopSystemVoice();
}
