# QuickRupee Voice Bot - AI Coding Guidelines

## Architecture Overview
This is a low-latency voice AI screening system for loan applicants. Audio flows: Twilio WebSocket → STT (Deepgram) → deterministic state machine → TTS (ElevenLabs) → back to caller. LLM (Claude) is used only post-call for analysis.

**Key Principles:**
- Streaming-first design with sub-500ms turn latency targets
- Deterministic eligibility logic outside LLM path (see `src/engine/validators.ts`)
- Event-loop concurrency with async/await
- High-resolution timing for latency metrics (see `src/metrics/collector.ts`)

## Core Components
- **Server**: Fastify with WebSocket support (`src/server.ts`)
- **Session**: Orchestrates STT/TTS/transport per call (`src/session/call-session.ts`)
- **State Machine**: Pure business logic, no audio/network (`src/engine/state-machine.ts`)
- **Transport**: Audio I/O abstraction (`src/transport/`)
- **Validators**: Regex/fuzzy matching for eligibility (`src/engine/validators.ts`)

## Development Workflow
- **Local dev**: `npm run dev` (tsx watch) + browser client at `/dev`
- **Build**: `npm run build` (TypeScript → `dist/`)
- **Production**: `npm start` (Node.js from `dist/`)
- **Type check**: `npm run typecheck`
- **Lint**: `npm run lint` (ESLint on `src/**/*.ts`)

## Code Patterns
- **Types**: All interfaces in `src/types/index.ts` (e.g., `ConversationState`, `EligibilityData`)
- **Logging**: Pino with call-specific loggers (`src/utils/logger.ts`)
- **Errors**: Custom `EngineError` class (`src/utils/errors.ts`)
- **Config**: Environment-based with fallbacks (`src/config/index.ts`)
- **Voice Profiles**: Predefined ElevenLabs configs for Indian English (`src/config/index.ts`)

## Integration Points
- **Twilio**: WebSocket media streams (μ-law PCM, base64) - see `src/telephony/twilio-handler.ts`
- **Deepgram**: Streaming STT with interim results for barge-in (`src/stt/deepgram-client.ts`)
- **ElevenLabs**: Streaming TTS with voice cloning (`src/tts/elevenlabs-client.ts`)
- **Claude**: Async post-call analysis (`src/llm/claude-worker.ts`)

## Conventions
- Eligibility checks: Employment (salaried/self-employed), salary parsing, location fuzzy matching
- States: `GREETING` → `ASK_EMPLOYMENT` → `ASK_SALARY` → `ASK_LOCATION` → `ELIGIBLE_CONFIRMATION`|`REJECTION`
- Low confidence → `CLARIFICATION` (max 2 attempts) → `DTMF_FALLBACK`
- Metrics: Prometheus-compatible latency tracking per turn

## Examples
- Add new eligibility field: Update `EligibilityData` in `types/index.ts`, add validator in `validators.ts`, extend state machine in `state-machine.ts`
- New voice profile: Add to `VOICE_PROFILES` in `config/index.ts`
- Custom prompt: Add to `src/engine/prompts.ts` and reference in state machine