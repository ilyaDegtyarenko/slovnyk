import { afterEach, describe, expect, it, vi } from "vitest";
import {
  bestEnglishVoice,
  pronounce,
  speechAvailable,
  stopPronunciation,
  warmUpVoices,
  type VoiceCandidate,
} from "./speech";

class FakeUtterance {
  text: string;
  lang = "";
  voice: VoiceCandidate | null = null;
  onend: (() => void) | null = null;
  onerror: ((event: { error: string }) => void) | null = null;

  constructor(text: string) {
    this.text = text;
  }
}

function fakeVoice(
  overrides: Partial<VoiceCandidate> & { name: string },
): VoiceCandidate {
  return {
    lang: "en-US",
    voiceURI: overrides.name,
    default: false,
    localService: true,
    ...overrides,
  };
}

function stubSpeech({
  speaking = false,
  pending = false,
  voices = [] as VoiceCandidate[],
} = {}) {
  const synthesis = {
    cancel: vi.fn(),
    speak: vi.fn(),
    getVoices: vi.fn(() => voices),
    speaking,
    pending,
  };
  vi.stubGlobal("SpeechSynthesisUtterance", FakeUtterance);
  vi.stubGlobal("window", { speechSynthesis: synthesis });
  return synthesis;
}

function spokenUtterance(
  synthesis: ReturnType<typeof stubSpeech>,
  call = 0,
): FakeUtterance {
  return synthesis.speak.mock.calls[call][0] as FakeUtterance;
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("speechAvailable", () => {
  it("is false where there is no window at all", () => {
    expect(speechAvailable()).toBe(false);
  });

  it("is false in a browser without the API", () => {
    vi.stubGlobal("window", {});
    expect(speechAvailable()).toBe(false);
  });

  it("is false when the property exists but holds nothing", () => {
    vi.stubGlobal("window", { speechSynthesis: undefined });
    expect(speechAvailable()).toBe(false);
  });

  it("is false when the utterance constructor is missing", () => {
    vi.stubGlobal("window", {
      speechSynthesis: { cancel: vi.fn(), speak: vi.fn() },
    });
    expect(speechAvailable()).toBe(false);
  });

  it("is true when the browser offers speech synthesis", () => {
    stubSpeech();
    expect(speechAvailable()).toBe(true);
  });
});

describe("warmUpVoices", () => {
  it("asks the engine for its voices so Chromium starts loading them", () => {
    const synthesis = stubSpeech();
    warmUpVoices();
    expect(synthesis.getVoices).toHaveBeenCalledTimes(1);
  });

  it("is a no-op where speech is unavailable", () => {
    expect(() => warmUpVoices()).not.toThrow();
  });

  it("survives an engine without getVoices", () => {
    vi.stubGlobal("SpeechSynthesisUtterance", FakeUtterance);
    vi.stubGlobal("window", {
      speechSynthesis: { cancel: vi.fn(), speak: vi.fn() },
    });
    expect(() => warmUpVoices()).not.toThrow();
  });
});

describe("bestEnglishVoice", () => {
  it("returns null when there are no voices", () => {
    expect(bestEnglishVoice([])).toBeNull();
  });

  it("returns null when no voice speaks English", () => {
    expect(
      bestEnglishVoice([
        fakeVoice({ name: "Milena", lang: "uk-UA" }),
        fakeVoice({ name: "Anna", lang: "de-DE" }),
      ]),
    ).toBeNull();
  });

  it("never selects a remote voice — pronunciation must survive offline", () => {
    const remoteNeural = fakeVoice({
      name: "Microsoft Aria Online (Natural) - English (United States)",
      localService: false,
    });
    const remoteGoogle = fakeVoice({
      name: "Google US English",
      localService: false,
    });
    const localPlain = fakeVoice({ name: "Fred" });

    expect(bestEnglishVoice([remoteNeural, remoteGoogle, localPlain])).toBe(
      localPlain,
    );
    expect(bestEnglishVoice([remoteNeural, remoteGoogle])).toBeNull();
  });

  it("treats a voice that does not report localService as local", () => {
    const undeclared = {
      name: "Fred",
      lang: "en-US",
      voiceURI: "Fred",
      default: false,
    } as VoiceCandidate;
    expect(bestEnglishVoice([undeclared])).toBe(undeclared);
  });

  it("ranks quality markers over listing order", () => {
    const premium = fakeVoice({ name: "Ava (Premium)" });
    const plain = fakeVoice({ name: "Fred" });
    expect(bestEnglishVoice([plain, premium])).toBe(premium);
  });

  it("prefers premium over enhanced over Samantha over unmarked voices", () => {
    const premium = fakeVoice({ name: "Ava (Premium)" });
    const enhanced = fakeVoice({ name: "Evan (Enhanced)" });
    const samantha = fakeVoice({ name: "Samantha" });
    const plain = fakeVoice({ name: "Fred" });

    expect(bestEnglishVoice([plain, samantha, enhanced, premium])).toBe(
      premium,
    );
    expect(bestEnglishVoice([plain, samantha, enhanced])).toBe(enhanced);
    expect(bestEnglishVoice([plain, samantha])).toBe(samantha);
  });

  it("reads quality markers from the voiceURI, where Apple hides them", () => {
    const premium = fakeVoice({
      name: "Ava",
      voiceURI: "com.apple.voice.premium.en-US.Ava",
    });
    expect(bestEnglishVoice([fakeVoice({ name: "Samantha" }), premium])).toBe(
      premium,
    );
  });

  it("prefers American English among equally natural voices", () => {
    const british = fakeVoice({ name: "Daniel", lang: "en-GB" });
    const american = fakeVoice({ name: "Fred", lang: "en-US" });
    expect(bestEnglishVoice([british, american])).toBe(american);
  });

  it("accepts bare 'en' but loses the American tiebreak to en-US", () => {
    const bare = fakeVoice({ name: "Fred", lang: "en" });
    const american = fakeVoice({ name: "Alex", lang: "en-US" });
    expect(bestEnglishVoice([bare])).toBe(bare);
    expect(bestEnglishVoice([bare, american])).toBe(american);
  });

  it("understands Android's underscore locale form", () => {
    const android = fakeVoice({ name: "English United States", lang: "en_US" });
    expect(bestEnglishVoice([android])).toBe(android);
  });

  it("skips a voice with no lang instead of crashing", () => {
    const broken = {
      ...fakeVoice({ name: "Broken" }),
      lang: undefined,
    } as unknown as VoiceCandidate;
    const american = fakeVoice({ name: "Fred" });
    expect(bestEnglishVoice([broken, american])).toBe(american);
    expect(bestEnglishVoice([broken])).toBeNull();
  });

  it("breaks remaining ties in favour of the platform default", () => {
    const first = fakeVoice({ name: "Fred" });
    const platformDefault = fakeVoice({ name: "Alex", default: true });
    expect(bestEnglishVoice([first, platformDefault])).toBe(platformDefault);
  });

  it("keeps the first listed voice when nothing distinguishes them", () => {
    const first = fakeVoice({ name: "Fred" });
    const second = fakeVoice({ name: "Alex" });
    expect(bestEnglishVoice([first, second])).toBe(first);
  });
});

describe("pronounce", () => {
  it("speaks the term as English regardless of the system locale", () => {
    const synthesis = stubSpeech();

    pronounce("flimsum");

    expect(synthesis.speak).toHaveBeenCalledTimes(1);
    const utterance = spokenUtterance(synthesis);
    expect(utterance.text).toBe("flimsum");
    expect(utterance.lang).toBe("en-US");
  });

  it("assigns the best English voice the engine offers", () => {
    const samantha = fakeVoice({ name: "Samantha" });
    const synthesis = stubSpeech({
      voices: [fakeVoice({ name: "Milena", lang: "uk-UA" }), samantha],
    });

    pronounce("flimsum");

    expect(spokenUtterance(synthesis).voice).toBe(samantha);
  });

  it("keeps the utterance lang in step with the chosen voice", () => {
    const british = fakeVoice({ name: "Daniel (Enhanced)", lang: "en-GB" });
    const synthesis = stubSpeech({ voices: [british] });

    pronounce("flimsum");

    expect(spokenUtterance(synthesis).lang).toBe("en-GB");
  });

  it("leaves the voice to the engine while the list is still empty", () => {
    const synthesis = stubSpeech();

    pronounce("flimsum");

    const utterance = spokenUtterance(synthesis);
    expect(utterance.voice).toBeNull();
    expect(utterance.lang).toBe("en-US");
  });

  it("leaves the voice to the engine when only remote English exists", () => {
    const remoteGoogle = fakeVoice({
      name: "Google US English",
      localService: false,
    });
    const synthesis = stubSpeech({ voices: [remoteGoogle] });

    pronounce("flimsum");

    const utterance = spokenUtterance(synthesis);
    expect(utterance.voice).toBeNull();
    expect(utterance.lang).toBe("en-US");
  });

  it("picks up a voice list that filled in after the first tap", () => {
    const samantha = fakeVoice({ name: "Samantha" });
    const synthesis = stubSpeech();
    synthesis.getVoices
      .mockReturnValueOnce([])
      .mockReturnValueOnce([samantha]);

    pronounce("flimsum");
    pronounce("flimsum");

    expect(spokenUtterance(synthesis, 0).voice).toBeNull();
    expect(spokenUtterance(synthesis, 1).voice).toBe(samantha);
  });

  it("retries with the engine default when the chosen voice fails", () => {
    const samantha = fakeVoice({ name: "Samantha" });
    const synthesis = stubSpeech({ voices: [samantha] });

    pronounce("flimsum");
    spokenUtterance(synthesis).onerror?.({ error: "synthesis-failed" });

    expect(synthesis.speak).toHaveBeenCalledTimes(2);
    const fallback = spokenUtterance(synthesis, 1);
    expect(fallback.text).toBe("flimsum");
    expect(fallback.voice).toBeNull();
    expect(fallback.lang).toBe("en-US");
  });

  it("does not retry after its own fallback fails — no loop between dead voices", () => {
    const samantha = fakeVoice({ name: "Samantha" });
    const synthesis = stubSpeech({ voices: [samantha] });

    pronounce("flimsum");
    spokenUtterance(synthesis).onerror?.({ error: "synthesis-failed" });
    spokenUtterance(synthesis, 1).onerror?.({ error: "synthesis-failed" });

    expect(synthesis.speak).toHaveBeenCalledTimes(2);
  });

  it("does not resurrect a deliberately cancelled word", () => {
    const samantha = fakeVoice({ name: "Samantha" });
    const synthesis = stubSpeech({ voices: [samantha] });

    pronounce("flimsum");
    spokenUtterance(synthesis).onerror?.({ error: "interrupted" });
    spokenUtterance(synthesis).onerror?.({ error: "canceled" });

    expect(synthesis.speak).toHaveBeenCalledTimes(1);
  });

  it("stays silent when a slow failure lands after the card was stopped", () => {
    const samantha = fakeVoice({ name: "Samantha" });
    const synthesis = stubSpeech({ voices: [samantha] });

    pronounce("flimsum");
    stopPronunciation();
    spokenUtterance(synthesis).onerror?.({ error: "network" });

    expect(synthesis.speak).toHaveBeenCalledTimes(1);
  });

  it("does not let a superseded utterance's late failure speak over the new one", () => {
    const samantha = fakeVoice({ name: "Samantha" });
    const synthesis = stubSpeech({ voices: [samantha] });

    pronounce("gorbik");
    pronounce("trellup");
    spokenUtterance(synthesis, 0).onerror?.({ error: "network" });

    expect(synthesis.speak).toHaveBeenCalledTimes(2);
  });

  it("does not cancel an idle engine — that can swallow the new utterance", () => {
    const synthesis = stubSpeech();

    pronounce("flimsum");

    expect(synthesis.cancel).not.toHaveBeenCalled();
  });

  it("cancels first when something is still playing, so nothing queues", () => {
    const synthesis = stubSpeech({ speaking: true });

    pronounce("gorbik");

    expect(synthesis.cancel).toHaveBeenCalledTimes(1);
    const cancelOrder = synthesis.cancel.mock.invocationCallOrder[0];
    const speakOrder = synthesis.speak.mock.invocationCallOrder[0];
    expect(cancelOrder).toBeLessThan(speakOrder);
  });

  it("cancels a queued-but-not-yet-audible utterance too", () => {
    const synthesis = stubSpeech({ pending: true });

    pronounce("trellup");

    expect(synthesis.cancel).toHaveBeenCalledTimes(1);
  });

  it("is a no-op where speech is unavailable", () => {
    expect(() => pronounce("flimsum")).not.toThrow();
  });

  it("survives a platform whose speechSynthesis is an empty stub", () => {
    vi.stubGlobal("window", { speechSynthesis: undefined });
    expect(() => pronounce("flimsum")).not.toThrow();
  });
});

describe("stopPronunciation", () => {
  it("cancels playback", () => {
    const synthesis = stubSpeech();

    stopPronunciation();

    expect(synthesis.cancel).toHaveBeenCalledTimes(1);
    expect(synthesis.speak).not.toHaveBeenCalled();
  });

  it("is a no-op where speech is unavailable", () => {
    expect(() => stopPronunciation()).not.toThrow();
  });

  it("is a no-op when the property exists but holds nothing", () => {
    vi.stubGlobal("window", { speechSynthesis: undefined });
    expect(() => stopPronunciation()).not.toThrow();
  });
});
