import { afterEach, describe, expect, it, vi } from "vitest";
import { pronounce, speechAvailable, stopPronunciation } from "./speech";

class FakeUtterance {
  text: string;
  lang = "";
  onend: (() => void) | null = null;

  constructor(text: string) {
    this.text = text;
  }
}

function stubSpeech({ speaking = false, pending = false } = {}) {
  const synthesis = { cancel: vi.fn(), speak: vi.fn(), speaking, pending };
  vi.stubGlobal("SpeechSynthesisUtterance", FakeUtterance);
  vi.stubGlobal("window", { speechSynthesis: synthesis });
  return synthesis;
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

describe("pronounce", () => {
  it("speaks the term as English regardless of the system locale", () => {
    const synthesis = stubSpeech();

    pronounce("flimsum");

    expect(synthesis.speak).toHaveBeenCalledTimes(1);
    const utterance = synthesis.speak.mock.calls[0][0] as FakeUtterance;
    expect(utterance.text).toBe("flimsum");
    expect(utterance.lang).toBe("en-US");
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
