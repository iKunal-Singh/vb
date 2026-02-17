/**
 * QuickRupee Voice Bot — Deterministic Validators
 *
 * Pure, synchronous business logic for eligibility screening.
 * These run in the real-time path and must execute in <10ms.
 *
 * NO LLM calls. NO network I/O. NO mutable global state.
 *
 * Three validators:
 *   1. EmploymentValidator — is the caller salaried?
 *   2. SalaryParser — extract and validate monthly salary
 *   3. LocationMatcher — is the caller in an eligible metro city?
 */

import { distance as levenshtein } from 'fastest-levenshtein';

// ════════════════════════════════════════════════════════════════
// 1. Employment Validator
// ════════════════════════════════════════════════════════════════

/** Pre-compiled regex patterns (compiled once at module load, reused per call) */
const YES_PATTERN = /^(yes|yeah|yep|yup|correct|right|haan|ha|ji|ji haan|sure|absolutely|definitely|of course|that's right)$/i;
const NO_PATTERN = /^(no|nope|nah|not|nahin|nahi|no way|not really|negative)$/i;

const SALARIED_KEYWORDS = [
    'salaried', 'employed', 'job', 'work', 'salary', 'company',
    'working', 'employee', 'office', 'corporate', 'mnc',
    'private sector', 'government', 'govt',
] as const;

const NON_SALARIED_KEYWORDS = [
    'self-employed', 'self employed', 'business', 'freelance', 'freelancer',
    'entrepreneur', 'own business', 'startup', 'contract', 'consultant',
    'unemployed', 'retired', 'student', 'housewife', 'homemaker',
] as const;

export class EmploymentValidator {
    /**
     * Determine if the caller is a salaried employee.
     *
     * @returns `true` if salaried, `false` if not, `null` if ambiguous
     *
     * Strategy:
     *   1. Exact yes/no match (fastest path)
     *   2. Keyword scanning with conflict resolution
     *   3. Return null for ambiguous input → triggers clarification
     */
    static validate(transcript: string): boolean | null {
        const normalized = transcript.toLowerCase().trim();

        // 1. Direct yes/no (most common case for a direct question)
        if (YES_PATTERN.test(normalized)) return true;
        if (NO_PATTERN.test(normalized)) return false;

        // 2. Keyword matching
        const hasSalaried = SALARIED_KEYWORDS.some((kw) => normalized.includes(kw));
        const hasNonSalaried = NON_SALARIED_KEYWORDS.some((kw) => normalized.includes(kw));

        // If both or neither → ambiguous
        if (hasSalaried && !hasNonSalaried) return true;
        if (hasNonSalaried && !hasSalaried) return false;

        // Ambiguous: both keywords present, or no keywords matched
        return null;
    }
}

// ════════════════════════════════════════════════════════════════
// 2. Salary Parser
// ════════════════════════════════════════════════════════════════

/**
 * Complete word-to-number mapping for Indian English salary mentions.
 * Supports values like "thirty five thousand" → 35000,
 * "one point five lakh" → 150000, "25k" → 25000.
 */
const WORD_TO_NUMBER: Readonly<Record<string, number>> = {
    zero: 0, one: 1, two: 2, three: 3, four: 4, five: 5,
    six: 6, seven: 7, eight: 8, nine: 9, ten: 10,
    eleven: 11, twelve: 12, thirteen: 13, fourteen: 14, fifteen: 15,
    sixteen: 16, seventeen: 17, eighteen: 18, nineteen: 19,
    twenty: 20, thirty: 30, forty: 40, fifty: 50,
    sixty: 60, seventy: 70, eighty: 80, ninety: 90,
    hundred: 100, thousand: 1000, lakh: 100000, lac: 100000, lakhs: 100000,
};

/** Salary must be within this range to be considered valid */
const SALARY_MIN = 1000;
const SALARY_MAX = 10_000_000; // 1 crore

export class SalaryParser {
    /**
     * Extract a monthly salary value from spoken text.
     *
     * @returns Salary as an integer, or `null` if unparseable
     *
     * Strategy (in priority order):
     *   1. Direct digit extraction: "25000", "25,000", "₹35000"
     *   2. 'k' shorthand: "25k", "30K"
     *   3. Lakh shorthand: "1.5 lakh"
     *   4. Word-to-number: "thirty five thousand"
     *   5. Contextual patterns: "I earn 30k per month"
     */
    static parse(transcript: string): number | null {
        const normalized = transcript.toLowerCase().trim();

        // Try each strategy in priority order
        return (
            SalaryParser.extractDirect(normalized) ??
            SalaryParser.extractKShorthand(normalized) ??
            SalaryParser.extractLakhShorthand(normalized) ??
            SalaryParser.extractWordToNumber(normalized) ??
            SalaryParser.extractContextual(normalized)
        );
    }

    /** Strategy 1: Pure digit extraction — "25000" or "25,000" */
    private static extractDirect(text: string): number | null {
        // Match digit sequences (optionally with commas or ₹ prefix)
        const match = text.match(/₹?\s*(\d{1,3}(?:,\d{3})*|\d{4,7})/);
        if (match?.[1]) {
            const num = parseInt(match[1].replace(/,/g, ''), 10);
            if (num >= SALARY_MIN && num <= SALARY_MAX) return num;
        }
        return null;
    }

    /** Strategy 2: K shorthand — "25k", "30K" */
    private static extractKShorthand(text: string): number | null {
        const match = text.match(/(\d+(?:\.\d+)?)\s*k\b/i);
        if (match?.[1]) {
            const num = Math.round(parseFloat(match[1]) * 1000);
            if (num >= SALARY_MIN && num <= SALARY_MAX) return num;
        }
        return null;
    }

    /** Strategy 3: Lakh shorthand — "1.5 lakh", "2 lakhs" */
    private static extractLakhShorthand(text: string): number | null {
        const match = text.match(/(\d+(?:\.\d+)?)\s*(?:lakh|lac|lakhs)\b/i);
        if (match?.[1]) {
            const num = Math.round(parseFloat(match[1]) * 100000);
            if (num >= SALARY_MIN && num <= SALARY_MAX) return num;
        }
        return null;
    }

    /**
     * Strategy 4: Word-to-number conversion
     *
     * Handles: "thirty five thousand", "twenty thousand",
     *          "one lakh", "fifty thousand rupees"
     *
     * Algorithm: accumulate small numbers, multiply by magnitude words.
     */
    private static extractWordToNumber(text: string): number | null {
        const words = text.split(/[\s,]+/);
        let total = 0;
        let current = 0;
        let hasNumericWord = false;

        for (const word of words) {
            const value = WORD_TO_NUMBER[word];
            if (value === undefined) continue;

            hasNumericWord = true;

            if (value === 100) {
                // "five hundred" → 500
                current = (current === 0 ? 1 : current) * 100;
            } else if (value >= 1000) {
                // "thirty thousand" → 30 * 1000
                current = (current === 0 ? 1 : current) * value;
                total += current;
                current = 0;
            } else {
                // Units and tens: accumulate
                current += value;
            }
        }

        total += current;

        if (!hasNumericWord || total === 0) return null;
        if (total >= SALARY_MIN && total <= SALARY_MAX) return total;

        return null;
    }

    /**
     * Strategy 5: Contextual patterns
     *
     * Handles: "I earn 30k per month", "my salary is around 40000",
     *          "I make thirty thousand"
     */
    private static extractContextual(text: string): number | null {
        const patterns = [
            // "earn 30k", "make 50000", "salary is 35000"
            /(?:earn|make|get|salary\s+is|income\s+is)\s*(?:around|about|approximately)?\s*₹?\s*(\d+)\s*k?\b/i,
            // "30 thousand", "25 thousand rupees"
            /(\d+)\s*(?:thousand|k)\s*(?:rupees|per\s+month|monthly)?/i,
        ];

        for (const pattern of patterns) {
            const match = text.match(pattern);
            if (match?.[1]) {
                let num = parseInt(match[1], 10);
                // If the original text has "k" or "thousand", multiply
                if ((text.includes('k') || text.includes('thousand')) && num < 1000) {
                    num *= 1000;
                }
                if (num >= SALARY_MIN && num <= SALARY_MAX) return num;
            }
        }

        return null;
    }

    /**
     * Parse a DTMF digit sequence into a salary.
     * User enters digits on keypad, terminated by '#'.
     * Example: "35000#" → 35000
     */
    static parseDTMF(digits: string): number | null {
        const cleaned = digits.replace(/[^0-9]/g, '');
        if (cleaned.length === 0) return null;
        const num = parseInt(cleaned, 10);
        if (num >= SALARY_MIN && num <= SALARY_MAX) return num;
        return null;
    }
}

// ════════════════════════════════════════════════════════════════
// 3. Location Matcher
// ════════════════════════════════════════════════════════════════

/** Eligible metro cities */
const METRO_CITIES = ['delhi', 'mumbai', 'bangalore'] as const;

/** Common aliases and alternate names → canonical city name */
const CITY_ALIASES: Readonly<Record<string, string>> = {
    // Delhi
    'new delhi': 'delhi',
    'ncr': 'delhi',
    'delhi ncr': 'delhi',
    'noida': 'delhi',
    'gurgaon': 'delhi',
    'gurugram': 'delhi',
    'faridabad': 'delhi',
    'ghaziabad': 'delhi',
    // Mumbai
    'bombay': 'mumbai',
    'navi mumbai': 'mumbai',
    'thane': 'mumbai',
    // Bangalore
    'bengaluru': 'bangalore',
    'blr': 'bangalore',
    'bangaluru': 'bangalore',
};

/** Maximum Levenshtein distance for fuzzy matching (handles typos/accent mispronunciation) */
const MAX_FUZZY_DISTANCE = 2;

export class LocationMatcher {
    /**
     * Match caller's location against eligible metro cities.
     *
     * @returns Canonical city name if matched, `null` if no match
     *
     * Strategy (in priority order):
     *   1. Direct substring match against metro city names
     *   2. Alias resolution (bombay → mumbai, ncr → delhi)
     *   3. Fuzzy match via Levenshtein distance (≤2 edits)
     */
    static match(transcript: string): string | null {
        const normalized = transcript.toLowerCase().trim();

        // 1. Direct match: check if any metro city name appears in the text
        for (const city of METRO_CITIES) {
            if (normalized.includes(city)) return city;
        }

        // 2. Alias match: check known alternate names
        for (const [alias, city] of Object.entries(CITY_ALIASES)) {
            if (normalized.includes(alias)) return city;
        }

        // 3. Fuzzy match: handle mispronunciation / STT errors
        //    Split into words and check each against metro cities
        const words = normalized.split(/[\s,]+/);
        for (const word of words) {
            if (word.length < 3) continue; // Skip very short words to avoid false positives
            for (const city of METRO_CITIES) {
                if (levenshtein(word, city) <= MAX_FUZZY_DISTANCE) return city;
            }
            // Also check against alias keys
            for (const [alias, city] of Object.entries(CITY_ALIASES)) {
                if (alias.split(' ').length === 1 && levenshtein(word, alias) <= MAX_FUZZY_DISTANCE) {
                    return city;
                }
            }
        }

        // No match — either not a metro city or unrecognizable
        return null;
    }

    /** Check if a matched location is an eligible metro city */
    static isEligible(location: string): boolean {
        return (METRO_CITIES as readonly string[]).includes(location.toLowerCase());
    }
}
