/** Keep account chrome useful even when an upstream identity claim is absent. */
export function safeAccountDisplayName(displayName: string | null | undefined, email: string): string {
  const name = displayName?.trim();
  if (name) return name;
  const localPart = email.trim().split("@", 1)[0]?.trim();
  return localPart || "Ledger Lines ユーザー";
}

/** Return at most two Unicode grapheme clusters, never half of an emoji or combining mark. */
export function getAvatarLabel(displayName: string | null | undefined, email: string): string {
  const value = safeAccountDisplayName(displayName, email);
  const segments =
    typeof Intl !== "undefined" && "Segmenter" in Intl
      ? Array.from(
          new Intl.Segmenter("ja", { granularity: "grapheme" }).segment(value),
          (segment) => segment.segment,
        )
      : Array.from(value);
  return segments.slice(0, 2).join("") || "LL";
}
