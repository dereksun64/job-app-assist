/**
 * An in-memory stand-in for the Artifact `db` capability, for page tests.
 * Like the real store it delivers snapshots asynchronously, notifies listeners after writes,
 * and enforces the path grammar's segment parity. Every write is logged in `writes`, so
 * tests can assert what a Candidate action stored.
 */
import type {
  CollectionReference,
  DashboardDb,
  DbError,
  DocumentReference,
  DocumentSnapshot,
  QuerySnapshot,
} from "../db.ts";

export type MemoryWrite =
  | { op: "set" | "update"; path: string; data: Record<string, unknown> }
  | { op: "delete"; path: string };

export interface MemoryDbOptions {
  /** Never answer subscriptions, like a store that cannot be reached. */
  silent?: boolean;
  /** End every subscription with this terminal error. */
  failWith?: DbError;
  /** Reject every write with this error, storing nothing. */
  failWritesWith?: DbError;
}

export interface MemoryDb extends DashboardDb {
  readonly writes: readonly MemoryWrite[];
  /** The current body of every document, keyed by path. */
  contents(): Record<string, Record<string, unknown>>;
}

const metadata = { fromCache: false, hasPendingWrites: false };

function segments(path: string): string[] {
  const parts = path.split("/");
  if (parts.some((part) => !/^[A-Za-z0-9_\-.~:@+]{1,200}$/.test(part) || /^\.\.?$/.test(part))) {
    throw new TypeError(`Invalid path: ${path}`);
  }
  return parts;
}

function clone<T>(value: T): T {
  return structuredClone(value);
}

export function createMemoryDb(
  initial: Record<string, object> = {},
  options: MemoryDbOptions = {},
): MemoryDb {
  const docs = new Map<string, Record<string, unknown>>();
  for (const [path, body] of Object.entries(initial)) {
    if (segments(path).length % 2 !== 0) throw new TypeError(`Not a document path: ${path}`);
    docs.set(path, clone(body as Record<string, unknown>));
  }
  const writes: MemoryWrite[] = [];
  const listeners = new Set<() => void>();

  const snapshotOf = (path: string): DocumentSnapshot => {
    const body = docs.get(path);
    const frozen = body === undefined ? undefined : Object.freeze(clone(body));
    return {
      id: path.slice(path.lastIndexOf("/") + 1),
      exists: body !== undefined,
      data: () => frozen,
      metadata,
    };
  };

  const querySnapshotOf = (collection: string): QuerySnapshot => {
    const depth = segments(collection).length + 1;
    const matched = [...docs.keys()]
      .filter((path) => path.startsWith(`${collection}/`) && path.split("/").length === depth)
      .sort()
      .map(snapshotOf);
    return { docs: matched, size: matched.length, empty: matched.length === 0, metadata };
  };

  function subscribe<T>(
    read: () => T,
    next: (snap: T) => void,
    error?: (e: DbError) => void,
  ): () => void {
    let active = true;
    const deliver = () => {
      queueMicrotask(() => {
        if (active) next(read());
      });
    };
    if (options.failWith) {
      const failure = options.failWith;
      queueMicrotask(() => {
        if (active) error?.(failure);
        active = false;
      });
      return () => {
        active = false;
      };
    }
    if (!options.silent) {
      listeners.add(deliver);
      deliver();
    }
    return () => {
      active = false;
      listeners.delete(deliver);
    };
  }

  const notify = () => {
    for (const listener of listeners) listener();
  };

  // The real store rejects with a plain { code, message } object, not an Error.
  const refuse = (error: DbError) =>
    // eslint-disable-next-line @typescript-eslint/prefer-promise-reject-errors
    Promise.reject(error);

  const doc = (path: string): DocumentReference => {
    if (segments(path).length % 2 !== 0) throw new TypeError(`Not a document path: ${path}`);
    return {
      id: path.slice(path.lastIndexOf("/") + 1),
      path,
      get: () => Promise.resolve(snapshotOf(path)),
      set: (data) => {
        if (options.failWritesWith) return refuse(options.failWritesWith);
        writes.push({ op: "set", path, data: clone(data) });
        docs.set(path, clone(data));
        notify();
        return Promise.resolve();
      },
      update: (data) => {
        if (options.failWritesWith) return refuse(options.failWritesWith);
        const current = docs.get(path);
        if (current === undefined) {
          const error: DbError = {
            code: "invalid_argument",
            message: `update needs an existing document at ${path}`,
          };
          return refuse(error);
        }
        writes.push({ op: "update", path, data: clone(data) });
        docs.set(path, mergeDeep(current, clone(data)));
        notify();
        return Promise.resolve();
      },
      delete: () => {
        if (options.failWritesWith) return refuse(options.failWritesWith);
        writes.push({ op: "delete", path });
        docs.delete(path);
        notify();
        return Promise.resolve();
      },
      onSnapshot: (next, error) => subscribe(() => snapshotOf(path), next, error),
    };
  };

  const collection = (path: string): CollectionReference => {
    if (segments(path).length % 2 !== 1) throw new TypeError(`Not a collection path: ${path}`);
    return {
      path,
      doc: (id) => doc(`${path}/${id}`),
      get: () => Promise.resolve(querySnapshotOf(path)),
      onSnapshot: (next, error) => subscribe(() => querySnapshotOf(path), next, error),
    };
  };

  return {
    doc,
    collection,
    get writes() {
      return writes;
    },
    contents: () => Object.fromEntries([...docs].map(([path, body]) => [path, clone(body)])),
  };
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Nested objects merge recursively; anything else, arrays included, replaces the field. */
function mergeDeep(
  target: Record<string, unknown>,
  patch: Record<string, unknown>,
): Record<string, unknown> {
  const merged = { ...target };
  for (const [key, value] of Object.entries(patch)) {
    const existing = merged[key];
    merged[key] =
      isPlainObject(existing) && isPlainObject(value) ? mergeDeep(existing, value) : value;
  }
  return merged;
}
