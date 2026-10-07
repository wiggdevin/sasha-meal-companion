export function sanitizeMealTitle(value: string): string {
  return value.replace(/[\u0000-\u001f\u007f-\u009f]/g, " ").trim().replace(/\s+/g, " ")
    .slice(0, 40);
}

/** Old rows gain a bounded dish name from their foods, never from a slot label. */
export function deriveMealTitle(items: readonly { name: string }[]): string | null {
  const names = items.map((item) => sanitizeMealTitle(item.name)).filter(Boolean);
  const joined = names.length < 2 ? (names[0] ?? items[0]?.name.trim() ?? "")
    : names.length === 2 ? `${names[0]} & ${names[1]}`
      : `${names.slice(0, -1).join(", ")} & ${names.at(-1)}`;
  const titled = `${joined.charAt(0).toUpperCase()}${joined.slice(1)}`;
  const sanitized = sanitizeMealTitle(titled);
  return sanitized && sanitized.toLowerCase() !== "meal" ? sanitized : null;
}
