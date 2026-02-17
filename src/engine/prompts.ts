/**
 * QuickRupee Voice Bot — Bot Response Prompts
 *
 * All text spoken by the bot is defined here as templates.
 * This centralises prompt management and makes it easy to A/B test copy.
 *
 * Responses are designed for warmth and brevity:
 *   - Short sentences reduce TTS generation time
 *   - Positive framing ("Great!") builds rapport
 *   - Pauses (SSML <break>) feel human
 */

// ─── Greeting ──────────────────────────────────────────────────

export const GREETING_MESSAGE =
    "Hi! Thank you for calling QuickRupee. I'll ask you a few quick questions to check your loan eligibility. Are you currently a salaried employee?";

// ─── Employment Question ───────────────────────────────────────

export const EMPLOYMENT_CLARIFICATION =
    "Just to confirm — are you currently employed on a salary? Please say yes or no.";

export const EMPLOYMENT_DTMF_FALLBACK =
    "I'm having a little trouble understanding. Please press 1 if you're a salaried employee, or 2 if not.";

// ─── Salary Question ───────────────────────────────────────────

export const ASK_SALARY_MESSAGE =
    "Great! What is your monthly in-hand salary?";

export const SALARY_CLARIFICATION =
    "I didn't quite catch that. Could you tell me your monthly salary in rupees? For example, thirty thousand.";

export const SALARY_DTMF_FALLBACK =
    "Please enter your monthly salary using the keypad, followed by the hash key.";

// ─── Location Question ─────────────────────────────────────────

export const ASK_LOCATION_MESSAGE =
    "Perfect. Which city do you currently live in?";

export const LOCATION_CLARIFICATION =
    "Sorry, I didn't catch that. Do you live in Delhi, Mumbai, or Bangalore?";

// ─── Outcomes ──────────────────────────────────────────────────

export const ELIGIBLE_MESSAGE =
    "Excellent news! You're eligible for a QuickRupee loan. Our team will call you back within 10 minutes to discuss your options. Thank you for your time!";

export const REJECTION_MESSAGES: Record<string, string> = {
    employment:
        "Thank you for your interest. Unfortunately, our current loan products are designed for salaried employees. We hope to expand our offerings soon. Have a great day!",
    salary:
        "Thank you for sharing that. Our minimum salary requirement is twenty-five thousand rupees per month. We appreciate your interest and wish you all the best!",
    location:
        "Thank you for your interest. We're currently serving customers in Delhi, Mumbai, and Bangalore. We're expanding to more cities soon. Have a wonderful day!",
    location_unclear:
        "I'm sorry, I wasn't able to confirm your city. Unfortunately, I can't proceed without that information. Please call back and we'll be happy to help. Thank you!",
};

// ─── Micro-Acknowledgements ────────────────────────────────────
// Sprinkled sparingly (every 2–3 turns) to signal active listening.

const ACKNOWLEDGEMENTS = [
    'Got it.',
    'I see.',
    'Understood.',
    'Okay.',
    'Alright.',
] as const;

/**
 * Returns a short acknowledgement phrase ~ every 3 turns.
 * Returns empty string otherwise to avoid sounding repetitive.
 */
export function generateAcknowledgement(turnCount: number): string {
    if (turnCount > 0 && turnCount % 3 === 0) {
        const idx = Math.floor(Math.random() * ACKNOWLEDGEMENTS.length);
        const ack = ACKNOWLEDGEMENTS[idx];
        return ack ? `${ack} ` : '';
    }
    return '';
}

// ─── Error / Edge-Case ─────────────────────────────────────────

export const UNEXPECTED_ERROR_MESSAGE =
    "I'm sorry, we're experiencing a technical issue. Please try calling back in a few minutes. Thank you for your patience.";

export const CALL_TIMEOUT_MESSAGE =
    "It seems we've lost connection. Thank you for calling QuickRupee. Please call back anytime!";
