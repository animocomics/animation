/**
 * Comparing an answer on a sheet with an option a teacher picked.
 *
 * Two spellings of the same thing used to count as different: `۴/۶` read from the
 * sheet and `2/3` typed in the editor. The editor then showed no option as the key,
 * the question looked like it had lost its answer, and the operator reported it as
 * "the options that had fractions came out broken". Equality here is equality of
 * value, not of spelling, so a fraction keeps its key however it was written.
 */

const PERSIAN_DIGITS = "۰۱۲۳۴۵۶۷۸۹";
const ARABIC_DIGITS = "٠١٢٣٤٥٦٧٨٩";

function asciiDigits(value: string): string {
  return value
    .replace(/[۰-۹]/g, (digit) => String(PERSIAN_DIGITS.indexOf(digit)))
    .replace(/[٠-٩]/g, (digit) => String(ARABIC_DIGITS.indexOf(digit)));
}

/** `4/6` → `2/3`. Returns null when the value is not a plain fraction. */
function reduceFraction(numerator: number, denominator: number): string | null {
  if (!denominator) return null;
  let a = Math.abs(numerator);
  let b = Math.abs(denominator);
  while (b) [a, b] = [b, a % b];
  const sign = numerator * denominator < 0 ? "-" : "";
  return `${sign}${Math.abs(numerator) / a}/${Math.abs(denominator) / a}`;
}

function fractionKey(value: string): string | null {
  const match = value.match(/^(-?\d+)\s*[/⁄]\s*(\d+)$/);
  if (!match) return null;
  return reduceFraction(Number(match[1]), Number(match[2]));
}

/**
 * The form used for comparing a key with an option.
 *
 * Mixed numbers are folded in first: `1 1/2` is written as `3/2`, because a teacher
 * reading a sheet may see the whole number part and the fraction as one value while
 * an option on the same sheet stores them as two tokens. Without this, `1 1/2` and
 * `3/2` looked like different options and the key silently failed to match.
 */
export function answerKey(value: string): string {
  const compact = value.trim().replace(/\s+/g, " ");
  const ascii = asciiDigits(compact);
  const mixed = ascii.match(/^(-?\d+)\s+(\d+)\s*[/⁄]\s*(\d+)$/);
  if (mixed) {
    const whole = Number(mixed[1]);
    const fraction = fractionKey(`${mixed[2]}/${mixed[3]}`);
    if (fraction && whole >= 0) {
      const [numerator, denominator] = fraction.split("/").map(Number);
      if (denominator) return reduceFraction(whole * denominator + numerator, denominator) ?? ascii;
    }
  }
  return fractionKey(ascii) ?? ascii;
}

/** True when both strings name the same answer, however each was written. */
export function sameAnswer(left: string, right: string): boolean {
  return answerKey(left) === answerKey(right) && Boolean(left.trim() && right.trim());
}
