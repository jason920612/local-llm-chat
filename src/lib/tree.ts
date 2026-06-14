import type { UIMessage } from "./types";

/**
 * Message-tree helpers (client-side). Messages form a tree via `parentId`;
 * siblings under the same parent are alternative versions. The displayed thread
 * is the path from the selected root, following each node's `activeChildId`
 * (falling back to its newest child when none is remembered).
 */

/** All messages sharing a parent, oldest-first — i.e. the version siblings. */
export function siblingsOf(
  messages: UIMessage[],
  msg: UIMessage,
): UIMessage[] {
  const parent = msg.parentId ?? null;
  return messages
    .filter((m) => (m.parentId ?? null) === parent)
    .sort((a, b) => (a.createdAt ?? 0) - (b.createdAt ?? 0));
}

/** Children of a node (or roots when parentId is null), oldest-first. */
function childrenOf(messages: UIMessage[], parentId: string | null): UIMessage[] {
  return messages
    .filter((m) => (m.parentId ?? null) === parentId)
    .sort((a, b) => (a.createdAt ?? 0) - (b.createdAt ?? 0));
}

/**
 * Compute the visible conversation path: start at the selected root, then follow
 * each node's remembered active child (or its newest child) down to a leaf.
 */
export function computePath(
  messages: UIMessage[],
  rootChildId: string | null,
): UIMessage[] {
  if (messages.length === 0) return [];
  const byId = new Map(messages.map((m) => [m.id, m]));

  const roots = childrenOf(messages, null);
  let node: UIMessage | undefined =
    (rootChildId && byId.get(rootChildId)) || roots[roots.length - 1];

  const path: UIMessage[] = [];
  const seen = new Set<string>();
  while (node && !seen.has(node.id)) {
    seen.add(node.id);
    path.push(node);
    const kids = childrenOf(messages, node.id);
    const next: UIMessage | undefined =
      (node.activeChildId ? byId.get(node.activeChildId) : undefined) ||
      kids[kids.length - 1];
    node = next;
  }
  // Safety net: if the tree links are somehow broken (no root reached) but
  // messages exist, fall back to a linear, time-ordered view so the
  // conversation never renders blank.
  if (path.length === 0) {
    return [...messages].sort((a, b) => (a.createdAt ?? 0) - (b.createdAt ?? 0));
  }
  return path;
}

/** The chain from the root down to (and including) `msg`, in order. */
export function ancestorsOf(messages: UIMessage[], msg: UIMessage): UIMessage[] {
  const byId = new Map(messages.map((m) => [m.id, m]));
  const chain: UIMessage[] = [];
  let node: UIMessage | undefined = msg;
  const seen = new Set<string>();
  while (node && !seen.has(node.id)) {
    seen.add(node.id);
    chain.unshift(node);
    node = node.parentId ? byId.get(node.parentId) : undefined;
  }
  return chain;
}

/** 1-based version index + count for a message among its siblings. */
export function versionInfo(
  messages: UIMessage[],
  msg: UIMessage,
): { index: number; count: number; siblings: UIMessage[] } {
  const siblings = siblingsOf(messages, msg);
  const index = siblings.findIndex((m) => m.id === msg.id);
  return { index: index < 0 ? 0 : index, count: siblings.length, siblings };
}
