import { readMachineTranslations, writeMachineTranslations } from "@/lib/db";
import type { Word } from "@/lib/sheet";
import {
  MAX_CHARACTERS_PER_REQUEST,
  MAX_TEXT_LENGTH,
  MAX_TEXTS_PER_REQUEST,
  TranslationResponse,
} from "@/lib/translate";

// Google's translation sits under the tutor's on the back of a card — for the term, and for
// the example sentence that shows the sense — so a doubtful translation can be checked
// without leaving the card. Each text is translated once while the network is here and kept
// on the device, so the second opinion is there offline too.

const TRANSLATE_PATH = "/api/translate";

// A hung request would hold up the rest of the pass, and the next sync retries anyway. Longer
// than the server takes at worst — ten seconds of starting groups, the last one bounded by
// Google's fifteen-second timeout — so a slow answer still lands.
const REQUEST_TIMEOUT_MS = 30_000;

export type MachineTranslations = ReadonlyMap<string, string>;

export const NO_MACHINE_TRANSLATIONS: MachineTranslations = new Map();

export function textsToTranslate(
  words: readonly Pick<Word, "term" | "example">[],
): string[] {
  const texts = words.flatMap((word) => [word.term, word.example]);
  // The server refuses anything longer, and one such text would sink its whole batch.
  return [...new Set(texts)].filter(
    (text) => text !== "" && text.length <= MAX_TEXT_LENGTH,
  );
}

// Splits the texts into requests the server accepts: by count, and by characters in all.
export function chunkTexts(texts: readonly string[]): string[][] {
  const chunks: string[][] = [];
  let chunk: string[] = [];
  let characters = 0;
  for (const text of texts) {
    const full =
      chunk.length === MAX_TEXTS_PER_REQUEST ||
      characters + text.length > MAX_CHARACTERS_PER_REQUEST;
    if (full && chunk.length > 0) {
      chunks.push(chunk);
      chunk = [];
      characters = 0;
    }
    chunk.push(text);
    characters += text.length;
  }
  if (chunk.length > 0) {
    chunks.push(chunk);
  }
  return chunks;
}

// What the card shows under the tutor's text, or null when Google adds nothing: no
// translation yet, or only words the card already shows — the tutor's translation, or the
// English itself, handed back untranslated for a name or a word Google does not know.
export function machineTranslationHint(
  machine: string | undefined,
  shown: readonly string[],
): string | null {
  if (machine === undefined) {
    return null;
  }
  const hint = collapseRepeatedAlternatives(machine.trim());
  if (hint === "" || shown.some((text) => comparable(text) === comparable(hint))) {
    return null;
  }
  return hint;
}

// Two English synonyms often share one Russian word: "irritate/ annoy" comes back as
// "раздражать/раздражать", which reads as a glitch rather than as an answer.
function collapseRepeatedAlternatives(text: string): string {
  const alternatives = text
    .split("/")
    .map((alternative) => alternative.trim())
    .filter((alternative) => alternative !== "");
  const distinct = alternatives.filter(
    (alternative, index) =>
      alternatives.findIndex((other) => comparable(other) === comparable(alternative)) ===
      index,
  );
  return distinct.length === alternatives.length ? text : distinct.join(" / ");
}

// Differences that say nothing about meaning: case, ё written as е, punctuation, spacing.
function comparable(text: string): string {
  return text
    .toLocaleLowerCase("ru")
    .replaceAll("ё", "е")
    .replace(/[.,!?;:"«»()…]/g, "")
    .replace(/\s*\/\s*/g, "/")
    .replace(/\s+/g, " ")
    .trim();
}

export async function loadMachineTranslations(): Promise<MachineTranslations> {
  try {
    const entries = await readMachineTranslations();
    return new Map(entries.map((entry) => [entry.text, entry.translation]));
  } catch {
    // Without storage the card shows the tutor's translation alone, as it always has.
    return NO_MACHINE_TRANSLATIONS;
  }
}

// One pass at a time — per tab, like sync. Two at once (a quick trip to List and back, or
// StrictMode's second mount) would both pay for the same missing texts, and the one that
// stopped early could land last and write its shorter set over the other's. A pass that
// waited its turn finds the first one's translations stored and asks only for the rest.
let pendingPass: Promise<unknown> = Promise.resolve();

// Asks the server for every text the device does not hold yet, drops the ones no word uses
// any more, and returns what the device holds afterwards.
export function prefetchMachineTranslations(
  texts: readonly string[],
  fetchImpl: typeof fetch = fetch,
): Promise<MachineTranslations> {
  const runPass = () => prefetchPass(texts, fetchImpl);
  const pass = pendingPass.then(runPass, runPass);
  pendingPass = pass;
  return pass;
}

async function prefetchPass(
  texts: readonly string[],
  fetchImpl: typeof fetch,
): Promise<MachineTranslations> {
  let stored: MachineTranslations;
  try {
    stored = new Map(
      (await readMachineTranslations()).map((entry) => [entry.text, entry.translation]),
    );
  } catch {
    // Read as empty, the row would be paid for again in full and then overwritten by
    // whatever part of the pass got through. Better to skip until storage answers.
    return NO_MACHINE_TRANSLATIONS;
  }
  // An empty list says more about the caller than about the vocabulary; wiping every
  // translation on its word would cost a full pass for nothing.
  if (texts.length === 0) {
    return stored;
  }

  const wanted = new Set(texts);
  const held = new Map([...stored].filter(([text]) => wanted.has(text)));
  const missing = [...wanted].filter((text) => !held.has(text));

  let unsaved = held.size !== stored.size;
  for (const chunk of chunkTexts(missing)) {
    const fetched = await requestTranslations(chunk, fetchImpl);
    // Whatever stopped this request — offline, locked, no key on the server — would stop
    // the next one too. The next sync picks the pass up again.
    if (fetched === null) {
      break;
    }
    if (fetched.size > 0) {
      for (const [text, translation] of fetched) {
        held.set(text, translation);
      }
      // Saved chunk by chunk: a pass cut short by a closed tab keeps what it paid for.
      await saveMachineTranslations(held);
      unsaved = false;
    }
  }

  if (unsaved) {
    await saveMachineTranslations(held);
  }
  return held;
}

async function saveMachineTranslations(held: MachineTranslations): Promise<void> {
  try {
    await writeMachineTranslations(
      [...held].map(([text, translation]) => ({ text, translation })),
    );
  } catch {
    // Out of storage: this visit still shows them, and the next one asks again.
  }
}

async function requestTranslations(
  texts: readonly string[],
  fetchImpl: typeof fetch,
): Promise<Map<string, string> | null> {
  let response: Response;
  try {
    response = await fetchImpl(TRANSLATE_PATH, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ texts }),
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
  } catch {
    return null;
  }
  if (!response.ok) {
    return null;
  }

  let body: unknown;
  try {
    body = await response.json();
  } catch {
    // The deadline covers the body too: a stall after the headers is the same dead
    // connection as one before them.
    return null;
  }
  const parsed = TranslationResponse.safeParse(body);
  if (!parsed.success) {
    return null;
  }

  // Only answers to what was asked are kept: the text each answer echoes back is the key
  // it is stored under, and an answer under any other key belongs to no card.
  const asked = new Set(texts);
  return new Map(
    parsed.data.translations
      .filter((entry) => asked.has(entry.text) && entry.translation.trim() !== "")
      .map((entry) => [entry.text, entry.translation]),
  );
}
