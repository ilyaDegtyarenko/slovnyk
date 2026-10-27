import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// The module keeps the prepared recording, the audio element, and downloads in flight at
// module level, so every test imports a fresh copy.
type PronunciationModule = typeof import("./pronunciation");

const ORIGIN = "https://slovnyk.test";
const MP3_BYTES = new Uint8Array([0x49, 0x44, 0x33, 0x04, 0x00]);

class FakeCache {
  readonly files = new Map<string, { body: Uint8Array<ArrayBuffer>; type: string }>();

  async match(key: string): Promise<Response | undefined> {
    const file = this.files.get(path(key));
    return file === undefined
      ? undefined
      : new Response(new Blob([file.body], { type: file.type }), {
          headers: { "Content-Type": file.type },
        });
  }

  async put(key: string, response: Response): Promise<void> {
    const body = new Uint8Array(await response.arrayBuffer());
    this.files.set(path(key), {
      body,
      type: response.headers.get("content-type") ?? "",
    });
  }

  async keys(): Promise<Request[]> {
    return [...this.files.keys()].map((key) => new Request(new URL(key, ORIGIN)));
  }

  async delete(request: Request): Promise<boolean> {
    return this.files.delete(path(request.url));
  }
}

function path(url: string): string {
  return new URL(url, ORIGIN).pathname;
}

class FakeAudio {
  static instances: FakeAudio[] = [];
  static play: () => Promise<void> = async () => {};

  src = "";
  currentTime = 7;
  preload = "";
  play = vi.fn(() => FakeAudio.play());
  pause = vi.fn();

  constructor() {
    FakeAudio.instances.push(this);
  }
}

class FakeUtterance {
  text: string;
  lang = "";
  voice: unknown = null;
  onend: (() => void) | null = null;
  onerror: ((event: { error: string }) => void) | null = null;

  constructor(text: string) {
    this.text = text;
  }
}

function audioResponse(status = 200, type = "audio/mpeg"): Response {
  return new Response(new Blob([MP3_BYTES], { type }), {
    status,
    headers: { "Content-Type": type },
  });
}

function errorResponse(status: number): Response {
  return new Response(JSON.stringify({ error: { code: "X", message: "no" } }), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

function setUpPlatform({ cacheStorage = true } = {}) {
  const cache = new FakeCache();
  const fetchMock = vi.fn<typeof fetch>(async () => audioResponse());
  const synthesis = {
    cancel: vi.fn(),
    speak: vi.fn(),
    getVoices: vi.fn(() => []),
    speaking: false,
    pending: false,
  };
  vi.stubGlobal("fetch", fetchMock);
  if (cacheStorage) {
    vi.stubGlobal("caches", { open: vi.fn(async () => cache) });
  }
  vi.stubGlobal("Audio", FakeAudio);
  vi.stubGlobal("SpeechSynthesisUtterance", FakeUtterance);
  vi.stubGlobal("window", { speechSynthesis: synthesis });
  const createObjectURL = vi.spyOn(URL, "createObjectURL");
  const revokeObjectURL = vi.spyOn(URL, "revokeObjectURL");
  return { cache, fetchMock, synthesis, createObjectURL, revokeObjectURL };
}

async function freshModule(): Promise<PronunciationModule> {
  vi.resetModules();
  return import("./pronunciation");
}

function requestedTerms(fetchMock: ReturnType<typeof vi.fn<typeof fetch>>): string[] {
  return fetchMock.mock.calls.map(
    ([url]) => new URL(String(url), ORIGIN).searchParams.get("term") ?? "",
  );
}

beforeEach(() => {
  FakeAudio.instances = [];
  FakeAudio.play = async () => {};
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("addresses", () => {
  it("puts the term in the query, encoded", async () => {
    const { pronunciationEndpoint } = await freshModule();

    expect(pronunciationEndpoint("rock & roll?")).toBe(
      "/api/pronounce?term=rock%20%26%20roll%3F",
    );
  });

  it("keys a stored file by voice as well as term", async () => {
    const { pronunciationCacheKey, PRONUNCIATION_VOICE } = await freshModule();

    expect(pronunciationCacheKey("give up")).toBe(
      `/pronunciations/${PRONUNCIATION_VOICE.name}/give%20up`,
    );
  });
});

describe("pronunciationAvailable", () => {
  it("is false on the server", async () => {
    const { pronunciationAvailable } = await freshModule();

    expect(pronunciationAvailable()).toBe(false);
  });

  it("is true in a browser that can play audio", async () => {
    setUpPlatform();
    const { pronunciationAvailable } = await freshModule();

    expect(pronunciationAvailable()).toBe(true);
  });

  it("is true with audio alone, without speech synthesis", async () => {
    setUpPlatform();
    vi.stubGlobal("window", {});
    const { pronunciationAvailable } = await freshModule();

    expect(pronunciationAvailable()).toBe(true);
  });
});

describe("loadPronunciation", () => {
  it("downloads a missing file once and serves it from the device afterwards", async () => {
    const { cache, fetchMock } = setUpPlatform();
    const { loadPronunciation, pronunciationCacheKey } = await freshModule();

    const first = await loadPronunciation("glimmerfold");
    const second = await loadPronunciation("glimmerfold");

    expect(first.ok && second.ok).toBe(true);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    // Without a deadline, a download that never settles keeps its term silent until reload.
    expect(fetchMock.mock.calls[0][1]?.signal).toBeInstanceOf(AbortSignal);
    expect(cache.files.get(pronunciationCacheKey("glimmerfold"))?.type).toBe(
      "audio/mpeg",
    );
    if (second.ok) {
      expect(new Uint8Array(await second.audio.arrayBuffer())).toEqual(MP3_BYTES);
    }
  });

  it("joins a download already in flight", async () => {
    const { fetchMock } = setUpPlatform();
    const { loadPronunciation } = await freshModule();

    const [first, second] = await Promise.all([
      loadPronunciation("glimmerfold"),
      loadPronunciation("glimmerfold"),
    ]);

    expect(first.ok && second.ok).toBe(true);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("asks the network nothing when the file is already stored", async () => {
    const { cache, fetchMock } = setUpPlatform();
    const { loadPronunciation, pronunciationCacheKey } = await freshModule();
    await cache.put(pronunciationCacheKey("glimmerfold"), audioResponse());

    expect((await loadPronunciation("glimmerfold")).ok).toBe(true);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it.each([
    [401, true],
    [503, true],
    [404, false],
    [502, false],
  ])("answers HTTP %i with blocked: %s and stores nothing", async (status, blocked) => {
    const { cache, fetchMock } = setUpPlatform();
    fetchMock.mockImplementation(async () => errorResponse(status));
    const { loadPronunciation } = await freshModule();

    expect(await loadPronunciation("glimmerfold")).toEqual({ ok: false, blocked });
    expect(cache.files.size).toBe(0);
  });

  it("treats a failed request as offline", async () => {
    const { fetchMock } = setUpPlatform();
    fetchMock.mockImplementation(async () => Promise.reject(new TypeError("offline")));
    const { loadPronunciation } = await freshModule();

    expect(await loadPronunciation("glimmerfold")).toEqual({ ok: false, blocked: true });
  });

  it("refuses a body that does not claim to be audio", async () => {
    const { cache, fetchMock } = setUpPlatform();
    fetchMock.mockImplementation(async () => audioResponse(200, "text/html"));
    const { loadPronunciation } = await freshModule();

    expect(await loadPronunciation("glimmerfold")).toEqual({ ok: false, blocked: false });
    expect(cache.files.size).toBe(0);
  });

  it("still plays without Cache Storage, downloading each time", async () => {
    const { fetchMock } = setUpPlatform({ cacheStorage: false });
    const { loadPronunciation } = await freshModule();

    expect((await loadPronunciation("glimmerfold")).ok).toBe(true);
    expect((await loadPronunciation("glimmerfold")).ok).toBe(true);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });
});

describe("prefetchPronunciations", () => {
  it("downloads each missing term once", async () => {
    const { cache, fetchMock } = setUpPlatform();
    const { prefetchPronunciations, pronunciationCacheKey } = await freshModule();
    await cache.put(pronunciationCacheKey("stored already"), audioResponse());

    await prefetchPronunciations(["glimmerfold", "stored already", "glimmerfold", "give up"]);

    expect(requestedTerms(fetchMock)).toEqual(["glimmerfold", "give up"]);
    expect(cache.files.size).toBe(3);
  });

  it("skips stored terms without reading their files", async () => {
    const { cache, fetchMock } = setUpPlatform();
    const { prefetchPronunciations, pronunciationCacheKey } = await freshModule();
    await cache.put(pronunciationCacheKey("glimmerfold"), audioResponse());
    const match = vi.spyOn(cache, "match");

    await prefetchPronunciations(["glimmerfold"]);

    expect(match).not.toHaveBeenCalled();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("stops at the first answer that would block every other word", async () => {
    const { fetchMock } = setUpPlatform();
    fetchMock.mockImplementation(async () => errorResponse(503));
    const { prefetchPronunciations } = await freshModule();

    await prefetchPronunciations(["glimmerfold", "give up", "on the fence"]);

    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("gives up after three failures in a row", async () => {
    const { fetchMock } = setUpPlatform();
    fetchMock.mockImplementation(async () => errorResponse(502));
    const { prefetchPronunciations } = await freshModule();

    await prefetchPronunciations(["one", "two", "three", "four", "five"]);

    expect(requestedTerms(fetchMock)).toEqual(["one", "two", "three"]);
  });

  it("starts counting failures afresh after a word that downloads", async () => {
    const { fetchMock } = setUpPlatform();
    fetchMock
      .mockImplementationOnce(async () => errorResponse(502))
      .mockImplementationOnce(async () => errorResponse(502))
      .mockImplementationOnce(async () => audioResponse())
      .mockImplementationOnce(async () => errorResponse(502))
      .mockImplementationOnce(async () => errorResponse(502));
    const { prefetchPronunciations } = await freshModule();

    await prefetchPronunciations(["one", "two", "three", "four", "five", "six"]);

    expect(requestedTerms(fetchMock)).toEqual(["one", "two", "three", "four", "five", "six"]);
  });

  it("downloads nothing on a device that cannot keep the files", async () => {
    const { fetchMock } = setUpPlatform({ cacheStorage: false });
    const { prefetchPronunciations } = await freshModule();

    await prefetchPronunciations(["glimmerfold", "give up"]);

    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("moves past a word the server does not know yet", async () => {
    const { cache, fetchMock } = setUpPlatform();
    fetchMock.mockImplementationOnce(async () => errorResponse(404));
    const { prefetchPronunciations, pronunciationCacheKey } = await freshModule();

    await prefetchPronunciations(["brandnewish", "glimmerfold"]);

    expect(requestedTerms(fetchMock)).toEqual(["brandnewish", "glimmerfold"]);
    expect([...cache.files.keys()]).toEqual([pronunciationCacheKey("glimmerfold")]);
  });

  it("drops files of removed terms and of other voices", async () => {
    const { cache } = setUpPlatform();
    const { prefetchPronunciations, pronunciationCacheKey } = await freshModule();
    await cache.put(pronunciationCacheKey("glimmerfold"), audioResponse());
    await cache.put(pronunciationCacheKey("removed from sheet"), audioResponse());
    await cache.put("/pronunciations/en-US-Retired-Voice/glimmerfold", audioResponse());

    await prefetchPronunciations(["glimmerfold"]);

    expect([...cache.files.keys()]).toEqual([pronunciationCacheKey("glimmerfold")]);
  });

  it("keeps every file when handed an empty list", async () => {
    const { cache, fetchMock } = setUpPlatform();
    const { prefetchPronunciations, pronunciationCacheKey } = await freshModule();
    await cache.put(pronunciationCacheKey("glimmerfold"), audioResponse());

    await prefetchPronunciations([]);

    expect(cache.files.size).toBe(1);
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe("pronounce", () => {
  async function preparedModule(term: string) {
    const platform = setUpPlatform();
    const pronunciation = await freshModule();
    pronunciation.preparePronunciation(term);
    await vi.waitFor(() => expect(platform.createObjectURL).toHaveBeenCalled());
    return { ...platform, ...pronunciation };
  }

  it("plays the prepared recording from the start, without the system voice", async () => {
    const { pronounce, createObjectURL, synthesis } = await preparedModule("glimmerfold");

    pronounce("glimmerfold");

    const [player] = FakeAudio.instances;
    expect(player.src).toBe(createObjectURL.mock.results[0].value);
    expect(player.currentTime).toBe(0);
    expect(player.play).toHaveBeenCalledTimes(1);
    expect(synthesis.speak).not.toHaveBeenCalled();
  });

  it("reuses one audio element for every tap", async () => {
    const { pronounce } = await preparedModule("glimmerfold");

    pronounce("glimmerfold");
    pronounce("glimmerfold");

    expect(FakeAudio.instances).toHaveLength(1);
    expect(FakeAudio.instances[0].play).toHaveBeenCalledTimes(2);
  });

  it("falls back to the system voice when no recording is ready", async () => {
    const { synthesis } = setUpPlatform();
    const { pronounce } = await freshModule();

    pronounce("glimmerfold");

    expect(synthesis.speak).toHaveBeenCalledTimes(1);
    expect(FakeAudio.instances).toHaveLength(0);
  });

  it("falls back to the system voice for a card whose recording is not the prepared one", async () => {
    const { pronounce, synthesis } = await preparedModule("glimmerfold");

    pronounce("give up");

    expect(synthesis.speak).toHaveBeenCalledTimes(1);
  });

  it("falls back to the system voice when the platform refuses to play", async () => {
    const { pronounce, synthesis } = await preparedModule("glimmerfold");
    FakeAudio.play = async () => {
      throw new DOMException("No gesture", "NotAllowedError");
    };

    pronounce("glimmerfold");

    await vi.waitFor(() => expect(synthesis.speak).toHaveBeenCalledTimes(1));
  });

  it("stays silent when playback was aborted on purpose", async () => {
    const { pronounce, synthesis } = await preparedModule("glimmerfold");
    FakeAudio.play = async () => {
      throw new DOMException("Interrupted", "AbortError");
    };

    pronounce("glimmerfold");
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(synthesis.speak).not.toHaveBeenCalled();
  });

  it("stays silent when a refusal lands after the card moved on", async () => {
    const { pronounce, stopPronunciation, synthesis } =
      await preparedModule("glimmerfold");
    let refuse: (error: unknown) => void = () => {};
    FakeAudio.play = () =>
      new Promise<void>((_resolve, reject) => {
        refuse = reject;
      });

    pronounce("glimmerfold");
    stopPronunciation();
    refuse(new DOMException("No gesture", "NotAllowedError"));
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(synthesis.speak).not.toHaveBeenCalled();
    expect(FakeAudio.instances[0].pause).toHaveBeenCalled();
  });

  it("does not install a recording for a card that already moved on", async () => {
    const { createObjectURL, synthesis } = setUpPlatform();
    const { preparePronunciation, pronounce, loadPronunciation } = await freshModule();

    const cleanup = preparePronunciation("glimmerfold");
    cleanup();
    await loadPronunciation("glimmerfold");
    await new Promise((resolve) => setTimeout(resolve, 0));
    pronounce("glimmerfold");

    expect(createObjectURL).not.toHaveBeenCalled();
    expect(synthesis.speak).toHaveBeenCalledTimes(1);
  });

  it("releases the previous card's recording when the next one is ready", async () => {
    const { preparePronunciation, createObjectURL, revokeObjectURL } =
      await preparedModule("glimmerfold");
    const firstUrl: unknown = createObjectURL.mock.results[0].value;

    preparePronunciation("give up");
    await vi.waitFor(() => expect(createObjectURL).toHaveBeenCalledTimes(2));

    expect(revokeObjectURL).toHaveBeenCalledWith(firstUrl);
  });
});
