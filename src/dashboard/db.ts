/**
 * The slice of the Artifact `db` capability the dashboard page uses, typed after the
 * platform's own definitions (runtime contract 0.2.96, db.d.ts). The page depends only on
 * this interface, so tests can hand it the in-memory fake in ./testing/memory-db.ts.
 */

export type DbErrorCode =
  | "invalid_argument"
  | "resource_exhausted"
  | "quota_exceeded"
  | "unavailable"
  | "revoked"
  | "not_granted"
  | "capability_disabled"
  | "capability_removed"
  | "transform_error";

export interface DbError {
  code: DbErrorCode;
  message: string;
}

export interface SnapshotMetadata {
  fromCache: boolean;
  hasPendingWrites: boolean;
}

export interface DocumentSnapshot {
  id: string;
  exists: boolean;
  data(): Record<string, unknown> | undefined;
  metadata: SnapshotMetadata;
}

export interface QuerySnapshot {
  docs: DocumentSnapshot[];
  size: number;
  empty: boolean;
  metadata: SnapshotMetadata;
}

export type Unsubscribe = () => void;

export interface DocumentReference {
  id: string;
  path: string;
  get(): Promise<DocumentSnapshot>;
  set(data: Record<string, unknown>): Promise<void>;
  update(data: Record<string, unknown>): Promise<void>;
  delete(): Promise<void>;
  onSnapshot(next: (snap: DocumentSnapshot) => void, error?: (e: DbError) => void): Unsubscribe;
}

export interface CollectionReference {
  path: string;
  doc(id: string): DocumentReference;
  get(): Promise<QuerySnapshot>;
  onSnapshot(next: (snap: QuerySnapshot) => void, error?: (e: DbError) => void): Unsubscribe;
}

export interface DashboardDb {
  doc(path: string): DocumentReference;
  collection(path: string): CollectionReference;
}
