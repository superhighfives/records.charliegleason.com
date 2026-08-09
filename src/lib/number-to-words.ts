const ONES = [
	"zero",
	"one",
	"two",
	"three",
	"four",
	"five",
	"six",
	"seven",
	"eight",
	"nine",
	"ten",
	"eleven",
	"twelve",
	"thirteen",
	"fourteen",
	"fifteen",
	"sixteen",
	"seventeen",
	"eighteen",
	"nineteen",
];

const TENS = [
	"",
	"",
	"twenty",
	"thirty",
	"forty",
	"fifty",
	"sixty",
	"seventy",
	"eighty",
	"ninety",
];

/** 0-99, hyphenated for the compound tens ("twenty-one"). */
function belowHundred(n: number): string {
	if (n < 20) return ONES[n];
	const tens = Math.floor(n / 10);
	const rest = n % 10;
	return rest ? `${TENS[tens]}-${ONES[rest]}` : TENS[tens];
}

/** 0-999, British "and" between the hundreds and the remainder. */
function belowThousand(n: number): string {
	if (n < 100) return belowHundred(n);
	const hundreds = Math.floor(n / 100);
	const rest = n % 100;
	return rest
		? `${ONES[hundreds]} hundred and ${belowHundred(rest)}`
		: `${ONES[hundreds]} hundred`;
}

/**
 * Spell out a non-negative integer in (British) English words — the hero
 * heading's "two hundred and eighty-three" treatment. Supports up to
 * 999,999, comfortably past any realistic collection size; anything larger
 * (or negative, or non-integer) falls back to the plain numeral rather than
 * guessing at a scale word.
 */
export function numberToWords(n: number): string {
	if (!Number.isInteger(n) || n < 0 || n > 999_999) return String(n);
	if (n === 0) return ONES[0];
	if (n < 1000) return belowThousand(n);
	const thousands = Math.floor(n / 1000);
	const rest = n % 1000;
	const thousandsWords = `${belowThousand(thousands)} thousand`;
	if (!rest) return thousandsWords;
	// "and" only when the remainder is itself below 100 (matches how you'd
	// actually say it: "two thousand and five", but "two thousand one
	// hundred and five", not "two thousand and one hundred and five").
	return rest < 100
		? `${thousandsWords} and ${belowHundred(rest)}`
		: `${thousandsWords} ${belowThousand(rest)}`;
}
