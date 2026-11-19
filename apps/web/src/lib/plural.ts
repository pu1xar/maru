/** "1 file", "3 files": the count with the noun in its singular or plural form. */
export function plural(count: number, one: string, many: string = `${one}s`): string {
  return `${count} ${count === 1 ? one : many}`;
}
