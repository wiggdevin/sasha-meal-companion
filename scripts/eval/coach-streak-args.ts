/** A flag's value when it has one; `--resolve --diagnosis x` has none, so the last open failure is meant. */
export function optionalValue(argv: readonly string[], name: string): string | null {
  const value = argv[argv.indexOf(name) + 1];
  return argv.includes(name) && value && !value.startsWith("--") ? value : null;
}
