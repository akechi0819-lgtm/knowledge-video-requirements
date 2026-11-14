// A style selection captures content, not just a library identifier.
export function sameStyle(a, b) {
  if (!a || !b) return a === b
  return a.id === b.id && a.name === b.name && a.description === b.description &&
    a.source?.kind === b.source?.kind && a.source?.label === b.source?.label
}
