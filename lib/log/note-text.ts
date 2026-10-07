/**
 * The one form a logged entry's note is stored in: surrounding whitespace dropped, and an empty
 * result means no note. `saveExtraNote` stores this; the note sheet compares and reports it, so a
 * saved note, an unchanged note and Undo all agree on what "the same note" is.
 */
export function canonicalNote(text: string): string {
  return text.trim();
}
