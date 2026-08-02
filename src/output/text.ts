export function sanitizeSingleLineText(value: string): string {
  let output = "";
  let replacingControlCharacters = false;

  for (const character of value) {
    const codePoint = character.codePointAt(0);
    const isControlCharacter =
      codePoint !== undefined &&
      (codePoint <= 0x1f ||
        (codePoint >= 0x7f && codePoint <= 0x9f) ||
        codePoint === 0x2028 ||
        codePoint === 0x2029);
    if (isControlCharacter) {
      if (!replacingControlCharacters) {
        output += " ";
      }
      replacingControlCharacters = true;
      continue;
    }
    output += character;
    replacingControlCharacters = false;
  }

  return output;
}
