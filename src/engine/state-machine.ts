/**
 * QuickRupee Voice Bot — Deterministic Conversation State Machine
 *
 * Governs the entire screening flow without any LLM in the loop.
 * Each state transition is explicit and testable.
 *
 * Flow:  GREETING → ASK_EMPLOYMENT → ASK_SALARY → ASK_LOCATION
 *          → ELIGIBLE_CONFIRMATION | REJECTION → ENDED
 *
 * Edges:
 *   - Low confidence STT → CLARIFICATION (re-ask, max 2 attempts)
 *   - Exceeded clarification attempts → DTMF_FALLBACK
 *   - Failed eligibility check → REJECTION
 *   - All three checks pass → ELIGIBLE_CONFIRMATION
 *
 * This module is pure business logic — it receives transcript strings
 * and returns bot response strings. It never touches audio or network.
 */

import { ConversationState } from '../types/index.js';
import type { ConversationContext, EligibilityData, TranscriptTurn } from '../types/index.js';
import { EmploymentValidator, SalaryParser, LocationMatcher } from './validators.js';
import {
    GREETING_MESSAGE,
    EMPLOYMENT_CLARIFICATION,
    EMPLOYMENT_DTMF_FALLBACK,
    ASK_SALARY_MESSAGE,
    SALARY_CLARIFICATION,
    SALARY_DTMF_FALLBACK,
    ASK_LOCATION_MESSAGE,
    LOCATION_CLARIFICATION,
    ELIGIBLE_MESSAGE,
    REJECTION_MESSAGES,
    UNEXPECTED_ERROR_MESSAGE,
    generateAcknowledgement,
} from './prompts.js';
import { EngineError } from '../utils/errors.js';

/** Maximum clarification attempts before falling back to DTMF */
const MAX_CLARIFICATION_ATTEMPTS = 2;

/**
 * Result of a state machine transition — what the bot should say
 * and whether the call should end.
 */
export interface StateMachineResult {
    /** Text for TTS to speak */
    response: string;
    /** Whether the conversation is over (hang up after TTS finishes) */
    shouldEnd: boolean;
    /** Current state after transition */
    newState: ConversationState;
}

export class ConversationStateMachine {
    private readonly context: ConversationContext;

    constructor(callId: string, phoneNumber: string) {
        this.context = {
            callId,
            phoneNumber,
            currentState: ConversationState.GREETING,
            previousState: null,
            eligibility: {
                isSalaried: null,
                salary: null,
                location: null,
            },
            turnCount: 0,
            clarificationAttempts: 0,
            transcript: [],
            isBotSpeaking: false,
            currentTurnStartNs: BigInt(0),
            rejectionReason: null,
        };
    }

    /** Read-only access to conversation context for logging/metrics */
    getContext(): Readonly<ConversationContext> {
        return this.context;
    }

    /** Get current eligibility data */
    getEligibility(): Readonly<EligibilityData> {
        return this.context.eligibility;
    }

    /** Get current state */
    getCurrentState(): ConversationState {
        return this.context.currentState;
    }

    /** Set bot speaking flag — used by barge-in detection */
    setBotSpeaking(speaking: boolean): void {
        this.context.isBotSpeaking = speaking;
    }

    /** Check if bot is currently speaking */
    isBotSpeaking(): boolean {
        return this.context.isBotSpeaking;
    }

    /** Set the turn start timestamp */
    setTurnStart(ns: bigint): void {
        this.context.currentTurnStartNs = ns;
    }

    /** Record a transcript turn */
    addTranscriptTurn(turn: TranscriptTurn): void {
        this.context.transcript.push(turn);
    }

    /** Get full transcript */
    getTranscript(): readonly TranscriptTurn[] {
        return this.context.transcript;
    }

    // ── Initial Greeting ──────────────────────────────────────────

    /**
     * Generate the opening greeting.
     * Called once when the call connects, before any user input.
     */
    startConversation(): StateMachineResult {
        this.context.currentState = ConversationState.ASK_EMPLOYMENT;
        return {
            response: GREETING_MESSAGE,
            shouldEnd: false,
            newState: this.context.currentState,
        };
    }

    // ── Main Input Handler ────────────────────────────────────────

    /**
     * Process user input and advance the state machine.
     *
     * @param transcript - Final STT transcript text
     * @param confidence - STT confidence score (0–1)
     * @returns Bot response text and whether to end the call
     */
    handleUserInput(transcript: string, confidence: number): StateMachineResult {
        this.context.turnCount++;

        // Low confidence → ask user to repeat (unless already in DTMF mode)
        if (confidence < 0.7 && this.context.currentState !== ConversationState.DTMF_FALLBACK) {
            return this.handleLowConfidence();
        }

        switch (this.context.currentState) {
            case ConversationState.ASK_EMPLOYMENT:
                return this.handleEmploymentResponse(transcript);

            case ConversationState.ASK_SALARY:
                return this.handleSalaryResponse(transcript);

            case ConversationState.ASK_LOCATION:
                return this.handleLocationResponse(transcript);

            case ConversationState.CLARIFICATION:
                return this.handleClarificationResponse(transcript);

            case ConversationState.DTMF_FALLBACK:
                // Voice input during DTMF mode — try to process anyway
                return this.handleClarificationResponse(transcript);

            case ConversationState.ELIGIBLE_CONFIRMATION:
            case ConversationState.REJECTION:
            case ConversationState.ENDED:
                // Call should already be ending
                return {
                    response: '',
                    shouldEnd: true,
                    newState: ConversationState.ENDED,
                };

            default:
                throw new EngineError(
                    `Unexpected state: ${this.context.currentState}`,
                    'ENGINE_INVALID_STATE'
                );
        }
    }

    // ── DTMF Input Handler ────────────────────────────────────────

    /**
     * Process DTMF (keypad) input.
     * Used as fallback when voice recognition fails repeatedly.
     */
    handleDTMFInput(digit: string): StateMachineResult {
        const returnState = this.context.previousState;

        switch (returnState) {
            case ConversationState.ASK_EMPLOYMENT: {
                if (digit === '1') {
                    this.context.eligibility.isSalaried = true;
                    this.context.currentState = ConversationState.ASK_SALARY;
                    this.context.clarificationAttempts = 0;
                    return {
                        response: `${generateAcknowledgement(this.context.turnCount)}${ASK_SALARY_MESSAGE}`,
                        shouldEnd: false,
                        newState: this.context.currentState,
                    };
                }
                if (digit === '2') {
                    this.context.eligibility.isSalaried = false;
                    return this.rejectCall('employment');
                }
                // Invalid DTMF — re-prompt
                return {
                    response: EMPLOYMENT_DTMF_FALLBACK,
                    shouldEnd: false,
                    newState: ConversationState.DTMF_FALLBACK,
                };
            }

            case ConversationState.ASK_SALARY: {
                // Accumulate digits — '#' terminates
                const salary = SalaryParser.parseDTMF(digit);
                if (salary !== null) {
                    this.context.eligibility.salary = salary;
                    if (salary < 25000) {
                        return this.rejectCall('salary');
                    }
                    this.context.currentState = ConversationState.ASK_LOCATION;
                    this.context.clarificationAttempts = 0;
                    return {
                        response: `${generateAcknowledgement(this.context.turnCount)}${ASK_LOCATION_MESSAGE}`,
                        shouldEnd: false,
                        newState: this.context.currentState,
                    };
                }
                return {
                    response: SALARY_DTMF_FALLBACK,
                    shouldEnd: false,
                    newState: ConversationState.DTMF_FALLBACK,
                };
            }

            default:
                // Unexpected DTMF context — ignore
                return {
                    response: '',
                    shouldEnd: false,
                    newState: this.context.currentState,
                };
        }
    }

    // ── Private State Handlers ────────────────────────────────────

    private handleEmploymentResponse(transcript: string): StateMachineResult {
        const isSalaried = EmploymentValidator.validate(transcript);
        this.context.eligibility.isSalaried = isSalaried;

        if (isSalaried === null) {
            return this.askClarification(
                ConversationState.ASK_EMPLOYMENT,
                EMPLOYMENT_CLARIFICATION,
                EMPLOYMENT_DTMF_FALLBACK
            );
        }

        if (!isSalaried) {
            return this.rejectCall('employment');
        }

        // Salaried ✓ → proceed to salary question
        this.context.currentState = ConversationState.ASK_SALARY;
        this.context.clarificationAttempts = 0;
        return {
            response: `${generateAcknowledgement(this.context.turnCount)}${ASK_SALARY_MESSAGE}`,
            shouldEnd: false,
            newState: this.context.currentState,
        };
    }

    private handleSalaryResponse(transcript: string): StateMachineResult {
        const salary = SalaryParser.parse(transcript);
        this.context.eligibility.salary = salary;

        if (salary === null) {
            return this.askClarification(
                ConversationState.ASK_SALARY,
                SALARY_CLARIFICATION,
                SALARY_DTMF_FALLBACK
            );
        }

        if (salary < 25000) {
            return this.rejectCall('salary');
        }

        // Salary ✓ → proceed to location question
        this.context.currentState = ConversationState.ASK_LOCATION;
        this.context.clarificationAttempts = 0;
        return {
            response: `${generateAcknowledgement(this.context.turnCount)}${ASK_LOCATION_MESSAGE}`,
            shouldEnd: false,
            newState: this.context.currentState,
        };
    }

    private handleLocationResponse(transcript: string): StateMachineResult {
        const location = LocationMatcher.match(transcript);
        this.context.eligibility.location = location;

        if (location === null) {
            this.context.clarificationAttempts++;
            if (this.context.clarificationAttempts > MAX_CLARIFICATION_ATTEMPTS) {
                return this.rejectCall('location_unclear');
            }
            this.context.currentState = ConversationState.CLARIFICATION;
            this.context.previousState = ConversationState.ASK_LOCATION;
            return {
                response: LOCATION_CLARIFICATION,
                shouldEnd: false,
                newState: this.context.currentState,
            };
        }

        if (!LocationMatcher.isEligible(location)) {
            return this.rejectCall('location');
        }

        // All three checks passed → eligible!
        this.context.currentState = ConversationState.ELIGIBLE_CONFIRMATION;
        return {
            response: ELIGIBLE_MESSAGE,
            shouldEnd: true,
            newState: this.context.currentState,
        };
    }

    /**
     * Handle user response during a CLARIFICATION state.
     * Routes back to the appropriate question handler based on previousState.
     */
    private handleClarificationResponse(transcript: string): StateMachineResult {
        const returnState = this.context.previousState;

        switch (returnState) {
            case ConversationState.ASK_EMPLOYMENT:
                this.context.currentState = ConversationState.ASK_EMPLOYMENT;
                return this.handleEmploymentResponse(transcript);

            case ConversationState.ASK_SALARY:
                this.context.currentState = ConversationState.ASK_SALARY;
                return this.handleSalaryResponse(transcript);

            case ConversationState.ASK_LOCATION:
                this.context.currentState = ConversationState.ASK_LOCATION;
                return this.handleLocationResponse(transcript);

            default:
                return {
                    response: UNEXPECTED_ERROR_MESSAGE,
                    shouldEnd: true,
                    newState: ConversationState.ENDED,
                };
        }
    }

    // ── Shared Logic ──────────────────────────────────────────────

    private handleLowConfidence(): StateMachineResult {
        this.context.clarificationAttempts++;

        if (this.context.clarificationAttempts > MAX_CLARIFICATION_ATTEMPTS) {
            // Exceeded max retries — fall back to DTMF
            this.context.previousState = this.context.currentState;
            this.context.currentState = ConversationState.DTMF_FALLBACK;

            switch (this.context.previousState) {
                case ConversationState.ASK_EMPLOYMENT:
                    return {
                        response: EMPLOYMENT_DTMF_FALLBACK,
                        shouldEnd: false,
                        newState: this.context.currentState,
                    };
                case ConversationState.ASK_SALARY:
                    return {
                        response: SALARY_DTMF_FALLBACK,
                        shouldEnd: false,
                        newState: this.context.currentState,
                    };
                default:
                    return {
                        response: "I'm sorry, I couldn't understand. Could you please repeat that?",
                        shouldEnd: false,
                        newState: this.context.currentState,
                    };
            }
        }

        // Ask user to repeat
        return {
            response: "I'm sorry, I didn't catch that clearly. Could you please repeat?",
            shouldEnd: false,
            newState: this.context.currentState,
        };
    }

    private askClarification(
        questionState: ConversationState,
        clarificationPrompt: string,
        dtmfFallbackPrompt: string
    ): StateMachineResult {
        this.context.clarificationAttempts++;

        if (this.context.clarificationAttempts > MAX_CLARIFICATION_ATTEMPTS) {
            this.context.previousState = questionState;
            this.context.currentState = ConversationState.DTMF_FALLBACK;
            return {
                response: dtmfFallbackPrompt,
                shouldEnd: false,
                newState: this.context.currentState,
            };
        }

        this.context.previousState = questionState;
        this.context.currentState = ConversationState.CLARIFICATION;
        return {
            response: clarificationPrompt,
            shouldEnd: false,
            newState: this.context.currentState,
        };
    }

    private rejectCall(reason: string): StateMachineResult {
        this.context.currentState = ConversationState.REJECTION;
        this.context.rejectionReason = reason;
        const message = REJECTION_MESSAGES[reason] ?? REJECTION_MESSAGES['employment']!;
        return {
            response: message,
            shouldEnd: true,
            newState: this.context.currentState,
        };
    }
}
