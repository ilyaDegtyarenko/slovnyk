import "fake-indexeddb/auto";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  db,
  readMachineTranslations,
  recordReview,
  writeMachineTranslations,
} from "@/lib/db";
import {
  chunkTexts,
  loadMachineTranslations,
  machineTranslationHint,
  prefetchMachineTranslations,
  textsToTranslate,
} from "@/lib/machine-translation";
import {
  MAX_CHARACTERS_PER_REQUEST,
  MAX_TEXT_LENGTH,
  MAX_TEXTS_PER_REQUEST,
} from "@/lib/translate";

function translationsResponse(
  translations: { text: string; translation: string }[],
  status = 200,
): Response {
  return new Response(JSON.stringify({ translations }), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

// Answers like the server: one translation per requested text, made up on the spot.
function fakeServer() {
  return vi.fn<typeof fetch>(async (_url, init) => {
    const { texts } = JSON.parse(String(init?.body)) as { texts: string[] };
    return translationsResponse(
      texts.map((text) => ({ text, translation: `перевод: ${text}` })),
    );
  });
}

function requestedTexts(fetchImpl: ReturnType<typeof fakeServer>): string[][] {
  return fetchImpl.mock.calls.map(
    ([, init]) => (JSON.parse(String(init?.body)) as { texts: string[] }).texts,
  );
}

beforeEach(async () => {
  await Promise.all([db.words.clear(), db.progress.clear(), db.reviews.clear(), db.meta.clear()]);
});

describe("textsToTranslate", () => {
  it("lists each term and non-empty example once", () => {
    expect(
      textsToTranslate([
        { term: "flonk", example: "A flonk sat on the wall." },
        { term: "wibbet", example: "" },
        { term: "flonk", example: "A flonk sat on the wall." },
      ]),
    ).toEqual(["flonk", "A flonk sat on the wall.", "wibbet"]);
  });

  it("leaves out an example longer than the server accepts", () => {
    const essay = "x".repeat(MAX_TEXT_LENGTH + 1);

    expect(textsToTranslate([{ term: "flonk", example: essay }])).toEqual(["flonk"]);
  });
});

describe("chunkTexts", () => {
  it("splits by count", () => {
    const texts = Array.from({ length: MAX_TEXTS_PER_REQUEST + 1 }, (_, index) => `w${index}`);

    const chunks = chunkTexts(texts);

    expect(chunks.map((chunk) => chunk.length)).toEqual([MAX_TEXTS_PER_REQUEST, 1]);
    expect(chunks.flat()).toEqual(texts);
  });

  it("splits by characters in all, never leaving an empty chunk", () => {
    const long = "x".repeat(MAX_TEXT_LENGTH);
    const perChunk = Math.floor(MAX_CHARACTERS_PER_REQUEST / MAX_TEXT_LENGTH);
    const texts = Array.from({ length: perChunk + 1 }, () => long);

    const chunks = chunkTexts(texts);

    expect(chunks.map((chunk) => chunk.length)).toEqual([perChunk, 1]);
    expect(chunkTexts([])).toEqual([]);
  });
});

describe("machineTranslationHint", () => {
  it("shows Google's words when they differ from what the card shows", () => {
    expect(machineTranslationHint("откладывать", ["отложить на потом", "flonk"])).toBe(
      "откладывать",
    );
  });

  it("says nothing without a translation, or when it only repeats the card", () => {
    expect(machineTranslationHint(undefined, ["раздражать"])).toBeNull();
    expect(machineTranslationHint("  ", ["раздражать"])).toBeNull();
    // Case, ё for е, punctuation and spacing around a slash are not a different answer.
    expect(machineTranslationHint("еще раз.", ["Ещё раз", "flonk"])).toBeNull();
    expect(
      machineTranslationHint("С одной стороны / С другой стороны", [
        "с одной стороны/ с другой стороны",
      ]),
    ).toBeNull();
    // A word Google does not know comes back as it went in.
    expect(machineTranslationHint("Flonk", ["флонк", "flonk"])).toBeNull();
  });

  it("collapses alternatives that came back as the same word", () => {
    expect(machineTranslationHint("раздражать/раздражать", ["злить"])).toBe("раздражать");
    expect(machineTranslationHint("Раздражать / раздражать", ["раздражать"])).toBeNull();
    expect(machineTranslationHint("бессмысленно/в чем-то нет смысла", ["x"])).toBe(
      "бессмысленно/в чем-то нет смысла",
    );
  });
});

describe("prefetchMachineTranslations", () => {
  it("fetches only what the device lacks and keeps it", async () => {
    await writeMachineTranslations([{ text: "flonk", translation: "флонк" }]);
    const fetchImpl = fakeServer();

    const held = await prefetchMachineTranslations(["flonk", "wibbet"], fetchImpl);

    expect(requestedTexts(fetchImpl)).toEqual([["wibbet"]]);
    expect(Object.fromEntries(held)).toEqual({
      flonk: "флонк",
      wibbet: "перевод: wibbet",
    });
    expect(await readMachineTranslations()).toEqual([
      { text: "flonk", translation: "флонк" },
      { text: "wibbet", translation: "перевод: wibbet" },
    ]);
  });

  it("asks nothing when every text is already on the device", async () => {
    await writeMachineTranslations([{ text: "flonk", translation: "флонк" }]);
    const fetchImpl = fakeServer();

    await prefetchMachineTranslations(["flonk"], fetchImpl);

    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("drops translations no current text uses", async () => {
    await writeMachineTranslations([
      { text: "flonk", translation: "флонк" },
      { text: "gone", translation: "нет" },
    ]);

    const held = await prefetchMachineTranslations(["flonk"], fakeServer());

    expect([...held.keys()]).toEqual(["flonk"]);
    expect(await readMachineTranslations()).toEqual([{ text: "flonk", translation: "флонк" }]);
  });

  it("keeps everything when handed an empty list", async () => {
    await writeMachineTranslations([{ text: "flonk", translation: "флонк" }]);
    const fetchImpl = fakeServer();

    const held = await prefetchMachineTranslations([], fetchImpl);

    expect(fetchImpl).not.toHaveBeenCalled();
    expect(Object.fromEntries(held)).toEqual({ flonk: "флонк" });
    expect(await readMachineTranslations()).toHaveLength(1);
  });

  it("asks once for each text when a second pass starts before the first ends", async () => {
    const fetchImpl = fakeServer();

    const [first, second] = await Promise.all([
      prefetchMachineTranslations(["flonk", "wibbet"], fetchImpl),
      prefetchMachineTranslations(["flonk", "wibbet", "zorvel"], fetchImpl),
    ]);

    expect(requestedTexts(fetchImpl)).toEqual([["flonk", "wibbet"], ["zorvel"]]);
    expect(first.size).toBe(2);
    expect(second.size).toBe(3);
    expect(await readMachineTranslations()).toHaveLength(3);
  });

  it("stops at the first refused request and keeps what arrived before it", async () => {
    const texts = Array.from({ length: MAX_TEXTS_PER_REQUEST * 2 + 1 }, (_, index) => `w${index}`);
    let calls = 0;
    const fetchImpl = vi.fn<typeof fetch>(async (_url, init) => {
      calls += 1;
      if (calls > 1) {
        return translationsResponse([], 503);
      }
      const { texts: asked } = JSON.parse(String(init?.body)) as { texts: string[] };
      return translationsResponse(asked.map((text) => ({ text, translation: "п" })));
    });

    const held = await prefetchMachineTranslations(texts, fetchImpl);

    // The third chunk is never asked for: whatever refused the second would refuse it too.
    expect(fetchImpl).toHaveBeenCalledTimes(2);
    expect(held.size).toBe(MAX_TEXTS_PER_REQUEST);
    expect(await readMachineTranslations()).toHaveLength(MAX_TEXTS_PER_REQUEST);
  });

  it("keeps each chunk on the device as soon as it arrives", async () => {
    const texts = Array.from({ length: MAX_TEXTS_PER_REQUEST + 1 }, (_, index) => `w${index}`);
    const storedBeforeSecondChunk: number[] = [];
    const server = fakeServer();
    const fetchImpl = vi.fn<typeof fetch>(async (url, init) => {
      if (server.mock.calls.length === 1) {
        storedBeforeSecondChunk.push((await readMachineTranslations()).length);
      }
      return server(url, init);
    });

    await prefetchMachineTranslations(texts, fetchImpl);

    // A tab closed while the second chunk is on its way loses only that chunk.
    expect(storedBeforeSecondChunk).toEqual([MAX_TEXTS_PER_REQUEST]);
  });

  it("still shows what it fetched when storage will not take it", async () => {
    vi.spyOn(db.meta, "put").mockRejectedValueOnce(new Error("quota exceeded"));

    const held = await prefetchMachineTranslations(["flonk"], fakeServer());

    expect(Object.fromEntries(held)).toEqual({ flonk: "перевод: flonk" });
  });

  it("asks nothing and writes nothing while storage cannot be read", async () => {
    await writeMachineTranslations([{ text: "flonk", translation: "флонк" }]);
    vi.spyOn(db.meta, "get").mockRejectedValueOnce(new Error("connection lost"));
    const fetchImpl = fakeServer();

    const held = await prefetchMachineTranslations(["flonk", "wibbet"], fetchImpl);

    expect(held.size).toBe(0);
    expect(fetchImpl).not.toHaveBeenCalled();
    expect(await readMachineTranslations()).toEqual([{ text: "flonk", translation: "флонк" }]);
  });

  it("gives up quietly when offline, keeping what the device holds", async () => {
    await writeMachineTranslations([{ text: "flonk", translation: "флонк" }]);
    const fetchImpl = vi.fn<typeof fetch>(async () => {
      throw new TypeError("Failed to fetch");
    });

    const held = await prefetchMachineTranslations(["flonk", "wibbet"], fetchImpl);

    expect(Object.fromEntries(held)).toEqual({ flonk: "флонк" });
    expect(await readMachineTranslations()).toEqual([{ text: "flonk", translation: "флонк" }]);
  });

  it("ignores an answer of the wrong shape, and answers to texts it never asked", async () => {
    const wrongShape = vi.fn<typeof fetch>(
      async () => new Response(JSON.stringify({ data: [] }), { status: 200 }),
    );
    const strayAnswer = vi.fn<typeof fetch>(async () =>
      translationsResponse([
        { text: "wibbet", translation: "виббет" },
        { text: "never asked", translation: "чужое" },
        { text: "flonk", translation: "" },
      ]),
    );

    expect((await prefetchMachineTranslations(["wibbet"], wrongShape)).size).toBe(0);
    const held = await prefetchMachineTranslations(["wibbet", "flonk"], strayAnswer);

    expect(Object.fromEntries(held)).toEqual({ wibbet: "виббет" });
  });

  it("never touches progress or the review log", async () => {
    const recorded = await recordReview({
      id: "wa3f19c2b81",
      rating: "good",
      now: new Date("2026-03-01T08:00:00.000Z"),
    });

    await prefetchMachineTranslations(["flonk"], fakeServer());
    await prefetchMachineTranslations(["wibbet"], fakeServer());

    expect(await db.progress.toArray()).toEqual([recorded.progress]);
    expect(await db.reviews.count()).toBe(1);
  });
});

describe("loadMachineTranslations", () => {
  it("reads what the device holds", async () => {
    await writeMachineTranslations([{ text: "flonk", translation: "флонк" }]);

    expect(Object.fromEntries(await loadMachineTranslations())).toEqual({ flonk: "флонк" });
  });

  it("reads nothing, rather than failing, when storage refuses", async () => {
    vi.spyOn(db.meta, "get").mockRejectedValueOnce(new Error("storage gone"));

    expect((await loadMachineTranslations()).size).toBe(0);
  });
});
