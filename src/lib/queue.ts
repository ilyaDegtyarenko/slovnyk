import type { ProgressRow, StoredWord } from "@/lib/db";

export type StudyQueue = {
  dueCards: StoredWord[];
  newCards: StoredWord[];
};

export function buildQueue(input: {
  words: StoredWord[];
  progress: ProgressRow[];
  now: Date;
  newPerDay: number;
}): StudyQueue {
  const nowMillis = input.now.getTime();
  const dueMillisById = new Map<string, number>(
    input.progress.map((row) => [row.id, dueMillisOf(row.due, nowMillis)]),
  );

  const due: { word: StoredWord; dueMillis: number }[] = [];
  const unseen: StoredWord[] = [];

  for (const word of input.words) {
    // An orphaned word keeps its progress and its history, but the tutor has taken it out
    // of the sheet, so it is not asked about again.
    if (word.orphaned) {
      continue;
    }

    const dueMillis = dueMillisById.get(word.id);
    if (dueMillis === undefined) {
      unseen.push(word);
      continue;
    }

    if (dueMillis <= nowMillis) {
      due.push({ word, dueMillis });
    }
  }

  // Sheet order breaks ties so that the same queue comes out of the same data, whatever
  // order the rows arrived from IndexedDB in.
  due.sort(
    (left, right) =>
      left.dueMillis - right.dueMillis || left.word.order - right.word.order,
  );
  unseen.sort((left, right) => left.order - right.order);

  return {
    dueCards: due.map((entry) => entry.word),
    newCards: unseen.slice(0, capOf(input.newPerDay)),
  };
}

// A due date this app cannot read must not make the word disappear from both lists: it is
// asked about now, and answering it writes a readable date back.
function dueMillisOf(due: string, nowMillis: number): number {
  const dueMillis = Date.parse(due);
  return Number.isNaN(dueMillis) ? nowMillis : dueMillis;
}

// A negative cap would slice from the end of the list instead of shortening it, and a
// NaN cap would silently return nothing at all.
function capOf(newPerDay: number): number {
  return Number.isFinite(newPerDay) ? Math.max(0, newPerDay) : 0;
}
