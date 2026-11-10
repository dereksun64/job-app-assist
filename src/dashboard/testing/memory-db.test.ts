import { describe, expect, it, vi } from "vitest";
import type { DocumentSnapshot } from "../db.ts";
import { createMemoryDb } from "./memory-db.ts";

describe("in-memory db fake", () => {
  it("reads seeded documents and reports missing ones", async () => {
    const db = createMemoryDb({ "settings/main": { a: 1 } });
    expect((await db.doc("settings/main").get()).data()).toEqual({ a: 1 });
    expect((await db.doc("settings/other").get()).exists).toBe(false);
  });

  it("delivers snapshots asynchronously and again after each write", async () => {
    const db = createMemoryDb();
    const next = vi.fn<(snap: DocumentSnapshot) => void>();
    db.doc("settings/main").onSnapshot(next);
    expect(next).not.toHaveBeenCalled();
    await Promise.resolve();
    expect(next).toHaveBeenLastCalledWith(expect.objectContaining({ exists: false }));
    await db.doc("settings/main").set({ a: 1 });
    await Promise.resolve();
    expect(next.mock.lastCall?.[0].data()).toEqual({ a: 1 });
  });

  it("stops delivering after unsubscribe", async () => {
    const db = createMemoryDb();
    const next = vi.fn();
    const unsubscribe = db.doc("settings/main").onSnapshot(next);
    unsubscribe();
    await db.doc("settings/main").set({ a: 1 });
    await Promise.resolve();
    expect(next).not.toHaveBeenCalled();
  });

  it("lists a collection's direct documents in id order", async () => {
    const db = createMemoryDb({
      "postings/b": { n: 2 },
      "postings/a": { n: 1 },
      "postings/a/notes/x": { n: 3 },
      "cards/c": { n: 4 },
    });
    const snap = await db.collection("postings").get();
    expect(snap.docs.map((d) => d.id)).toEqual(["a", "b"]);
  });

  it("merges updates deeply, replaces arrays, and rejects updates to missing documents", async () => {
    const db = createMemoryDb({ "cards/c": { stage: { name: "Queued", at: 1 }, flags: ["x"] } });
    await db.doc("cards/c").update({ stage: { name: "Submitted" }, flags: [] });
    expect(db.contents()["cards/c"]).toEqual({ stage: { name: "Submitted", at: 1 }, flags: [] });
    await expect(db.doc("cards/none").update({ a: 1 })).rejects.toMatchObject({
      code: "invalid_argument",
    });
  });

  it("logs every write", async () => {
    const db = createMemoryDb({ "cards/c": { a: 1 } });
    await db.doc("cards/c").update({ b: 2 });
    await db.doc("cards/d").set({ c: 3 });
    await db.doc("cards/c").delete();
    expect(db.writes).toEqual([
      { op: "update", path: "cards/c", data: { b: 2 } },
      { op: "set", path: "cards/d", data: { c: 3 } },
      { op: "delete", path: "cards/c" },
    ]);
  });

  it("keeps stored documents safe from mutation by callers", async () => {
    const body = { list: [1] };
    const db = createMemoryDb();
    await db.doc("cards/c").set(body);
    body.list.push(2);
    const data = (await db.doc("cards/c").get()).data();
    expect(data).toEqual({ list: [1] });
    expect(Object.isFrozen(data)).toBe(true);
  });

  it("throws for paths with the wrong parity or characters, like the real store", () => {
    const db = createMemoryDb();
    expect(() => db.doc("settings")).toThrow(TypeError);
    expect(() => db.collection("settings/main")).toThrow(TypeError);
    expect(() => db.doc("settings/ma in")).toThrow(TypeError);
  });

  it("ends subscriptions with a configured terminal error", async () => {
    const db = createMemoryDb({}, { failWith: { code: "revoked", message: "gone" } });
    const next = vi.fn();
    const error = vi.fn();
    db.doc("settings/main").onSnapshot(next, error);
    await Promise.resolve();
    expect(error).toHaveBeenCalledWith({ code: "revoked", message: "gone" });
    expect(next).not.toHaveBeenCalled();
  });

  it("rejects every write with the configured error and stores nothing", async () => {
    const failure = { code: "quota_exceeded", message: "full" } as const;
    const db = createMemoryDb({ "settings/main": { a: 1 } }, { failWritesWith: failure });
    await expect(db.doc("settings/main").set({ a: 2 })).rejects.toEqual(failure);
    await expect(db.doc("settings/main").update({ a: 2 })).rejects.toEqual(failure);
    await expect(db.doc("settings/main").delete()).rejects.toEqual(failure);
    expect(db.writes).toEqual([]);
    expect(db.contents()).toEqual({ "settings/main": { a: 1 } });
  });
});
