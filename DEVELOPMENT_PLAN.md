# QuickRupee Voice AI Screening System - Production Development Plan

## Executive Summary

This document provides a production-grade architectural blueprint for a low-latency, human-like inbound voice screening system for QuickRupee digital lending. The system screens loan applicants through 3 deterministic eligibility questions with sub-500ms conversational turn latency, warm voice interactions, and comprehensive observability.

**Core Design Principles:**
- Streaming-first architecture (STT, TTS, WebSocket)
- Deterministic logic outside LLM path
- Sub-500ms target turn latency
- Human-like conversational UX
- Production-grade instrumentation
- India-region deployment for latency optimization

---

## 1. System Architecture

### 1.1 High-Level Architecture

```
┌─────────────────────────────────────────────────────────────────┐
│                         PSTN/SIP Network                         │
└───────────────────────────────┬─────────────────────────────────┘
                                │
                    ┌───────────▼──────────┐
                    │   Twilio Voice API   │
                    │   (Mumbai Region)    │
                    └───────────┬──────────┘
                                │
                    ┌───────────▼──────────┐
                    │  TwiML WebSocket     │
                    │  Bidirectional       │
                    │  Media Stream        │
                    └───────────┬──────────┘
                                │
                                │ μ-law PCM 8kHz
                                │ Base64 encoded
                                │
┌───────────────────────────────▼───────────────────────────────┐
│                    VOICE ENGINE (Node.js)                      │
│  ┌─────────────────────────────────────────────────────────┐  │
│  │          WebSocket Handler (ws library)                  │  │
│  │  - Connection management                                 │  │
│  │  - Audio chunk buffering                                 │  │
│  │  - Barge-in detection                                    │  │
│  └──────────┬────────────────────────────────┬──────────────┘  │
│             │                                │                 │
│  ┌──────────▼─────────┐          ┌──────────▼──────────┐      │
│  │  STT Stream        │          │  TTS Stream         │      │
│  │  (Deepgram Nova-2) │          │  (ElevenLabs)       │      │
│  │  - WebSocket       │          │  - WebSocket        │      │
│  │  - Streaming       │          │  - Streaming        │      │
│  │  - Confidence      │          │  - Voice cloning    │      │
│  └──────────┬─────────┘          └──────────▲──────────┘      │
│             │                                │                 │
│  ┌──────────▼────────────────────────────────┴──────────┐      │
│  │         Conversation State Machine                   │      │
│  │  ┌────────────────────────────────────────────────┐  │      │
│  │  │  States:                                       │  │      │
│  │  │  - GREETING                                    │  │      │
│  │  │  - ASK_EMPLOYMENT_STATUS                       │  │      │
│  │  │  - ASK_SALARY                                  │  │      │
│  │  │  - ASK_LOCATION                                │  │      │
│  │  │  - ELIGIBLE_CONFIRMATION                       │  │      │
│  │  │  - REJECTION                                   │  │      │
│  │  │  - CLARIFICATION (low confidence)              │  │      │
│  │  │  - DTMF_FALLBACK                               │  │      │
│  │  └────────────────────────────────────────────────┘  │      │
│  │                                                       │      │
│  │  ┌────────────────────────────────────────────────┐  │      │
│  │  │  Eligibility Engine (Deterministic)            │  │      │
│  │  │  - Employment validator                        │  │      │
│  │  │  - Salary parser & validator                   │  │      │
│  │  │  - Location matcher                            │  │      │
│  │  └────────────────────────────────────────────────┘  │      │
│  └───────────────────────────────────────────────────────┘      │
│                                                                 │
│  ┌─────────────────────────────────────────────────────────┐   │
│  │  Latency Instrumentation Layer                          │   │
│  │  - Per-component timing                                 │   │
│  │  - Prometheus metrics                                   │   │
│  │  - Structured logging (Pino)                            │   │
│  └─────────────────────────────────────────────────────────┘   │
└─────────────────────────────┬───────────────────────────────────┘
                              │
                  ┌───────────▼──────────┐
                  │   PostgreSQL         │
                  │   - Call logs        │
                  │   - Transcripts      │
                  │   - Eligibility      │
                  └──────────────────────┘
                              │
                  ┌───────────▼──────────┐
                  │  Async Worker Queue  │
                  │  (BullMQ + Redis)    │
                  └───────────┬──────────┘
                              │
                  ┌───────────▼──────────┐
                  │  Claude Opus API     │
                  │  - Callback notes    │
                  │  - Sentiment         │
                  │  - Quality scoring   │
                  └──────────────────────┘
```

### 1.2 Component Breakdown

#### **Telephony Layer (Twilio)**
- **Role**: PSTN/SIP ingress, media streaming
- **Configuration**: Mumbai region endpoint
- **Protocol**: WebSocket media streams (μ-law PCM, 8kHz, base64)
- **Capabilities**: Bidirectional audio, DTMF detection, call control

#### **Voice Engine (Node.js + TypeScript)**
- **Framework**: Fastify (low-overhead HTTP/WebSocket)
- **Runtime**: Node.js 20 LTS
- **Concurrency**: Event-loop based, async/await
- **Key modules**:
  - `WebSocketManager`: Connection lifecycle, audio buffering
  - `ConversationStateMachine`: Turn management, state transitions
  - `EligibilityEngine`: Deterministic business logic
  - `AudioPipeline`: STT/TTS orchestration
  - `MetricsCollector`: Latency tracking, Prometheus export

#### **STT Layer (Deepgram Nova-2)**
- **Model**: Nova-2 (optimized for telephony)
- **Mode**: Streaming WebSocket
- **Features**: 
  - Interim results for barge-in detection
  - Confidence scores per utterance
  - Numeric entity recognition
  - Indian English accent support
- **Latency target**: <150ms first token

#### **TTS Layer (ElevenLabs Turbo v2.5)**
- **Model**: Turbo v2.5 (lowest latency)
- **Mode**: Streaming WebSocket
- **Features**:
  - Voice cloning for warmth
  - SSML support for prosody
  - Streaming chunk delivery
- **Latency target**: <200ms first byte
- **Alternative**: PlayHT 3.0-mini (backup)

#### **Eligibility Engine**
- **Language**: TypeScript
- **Execution**: Synchronous, deterministic
- **Components**:
  - `EmploymentValidator`: Regex + keyword matching
  - `SalaryParser`: NLP-lite numeric extraction
  - `LocationMatcher`: Fuzzy string matching (Levenshtein)
- **Latency**: <10ms per evaluation

#### **Data Layer**
- **Primary DB**: PostgreSQL 16 (Supabase/Neon)
- **Schema**:
  - `calls`: call_id, phone_number, start_time, end_time, status
  - `transcripts`: turn_id, call_id, speaker, text, confidence, timestamp
  - `eligibility_results`: call_id, employment, salary, location, eligible, created_at
- **Queue**: Redis + BullMQ for async jobs

#### **LLM Layer (Claude Opus)**
- **Usage**: Post-call only (NOT in real-time path)
- **Tasks**:
  - Generate callback notes for sales team
  - Sentiment analysis
  - Conversation quality scoring
- **Invocation**: Async worker triggered after call ends

---

## 2. Latency Budget

### 2.1 Per-Component Latency

| Component | Target (ms) | P95 (ms) | P99 (ms) | Notes |
|-----------|-------------|----------|----------|-------|
| **Twilio Routing** | 50 | 80 | 120 | Mumbai region reduces by ~40ms vs US |
| **WebSocket RTT** | 20 | 35 | 50 | India-hosted server |
| **STT First Token** | 150 | 200 | 300 | Deepgram Nova-2 streaming |
| **STT Full Utterance** | 300 | 400 | 600 | End-of-speech detection |
| **Logic Evaluation** | 10 | 15 | 25 | Synchronous JS execution |
| **TTS First Byte** | 200 | 280 | 400 | ElevenLabs Turbo v2.5 |
| **TTS Full Response** | 800 | 1200 | 1800 | Depends on response length |
| **Audio Playback Start** | 50 | 80 | 120 | Twilio buffer + network |
| **TOTAL TURN LATENCY** | **480** | **695** | **1015** | User stops speaking → Bot starts speaking |

### 2.2 Optimization Strategies

**STT Optimization:**
- Use interim results to predict end-of-speech
- Implement voice activity detection (VAD) for faster cutoff
- Tune Deepgram `endpointing` parameter (300ms default → 200ms)

**TTS Optimization:**
- Pre-generate static prompts (greeting, rejection messages)
- Stream TTS chunks immediately (don't wait for full generation)
- Use shorter, punchier responses (reduce generation time)

**Network Optimization:**
- Deploy on AWS Mumbai (ap-south-1) or GCP Mumbai (asia-south1)
- Use HTTP/2 for TTS/STT connections
- Enable WebSocket compression (permessage-deflate)

**Logic Optimization:**
- Cache location fuzzy-match results
- Pre-compile regex patterns
- Use typed data structures (avoid runtime validation)

### 2.3 Bottleneck Analysis

**Primary Bottleneck**: TTS first byte (200ms)
- **Mitigation**: Pre-generate common responses, use streaming aggressively

**Secondary Bottleneck**: STT end-of-speech detection (300ms)
- **Mitigation**: Tune endpointing, use interim results for prediction

**Tertiary Bottleneck**: Network jitter (variable)
- **Mitigation**: Deploy in same region as Twilio, use adaptive buffering

---

## 3. Technology Stack Justification

### 3.1 Telephony: Twilio

**Chosen**: Twilio Programmable Voice
**Alternatives Considered**: Vonage, Plivo, Exotel

**Justification**:
- **Streaming support**: Native WebSocket media streams (required)
- **India presence**: Mumbai region (lower latency vs US-only providers)
- **Reliability**: 99.95% SLA, battle-tested at scale
- **Developer UX**: Excellent documentation, SDKs, debugging tools
- **DTMF support**: Fallback for low STT confidence
- **Cost**: $0.0085/min India inbound (competitive)

**Why not alternatives**:
- Vonage: No streaming media API (webhook-only gather)
- Plivo: Limited India region support
- Exotel: No WebSocket streaming

### 3.2 STT: Deepgram Nova-2

**Chosen**: Deepgram Nova-2
**Alternatives Considered**: Google Speech-to-Text, AssemblyAI, Whisper API

**Justification**:
- **Latency**: 150ms first token (fastest in class)
- **Streaming**: Native WebSocket, interim results
- **Accuracy**: 95%+ on telephony audio (8kHz)
- **Indian English**: Trained on Indian accents
- **Confidence scores**: Per-utterance confidence for fallback logic
- **Numeric recognition**: Handles "twenty-five thousand" → 25000
- **Cost**: $0.0043/min (cheaper than Google)

**Why not alternatives**:
- Google STT: 250ms+ first token, higher cost
- AssemblyAI: No real-time streaming (async only)
- Whisper API: 500ms+ latency (not streaming)

### 3.3 TTS: ElevenLabs Turbo v2.5

**Chosen**: ElevenLabs Turbo v2.5
**Alternatives Considered**: PlayHT 3.0, Google TTS, Azure TTS

**Justification**:
- **Latency**: 200ms first byte (streaming)
- **Naturalness**: Human-like prosody, emotion
- **Voice cloning**: Custom voice profiles for brand warmth
- **Streaming**: WebSocket chunked delivery
- **SSML support**: Prosody control (pauses, emphasis)
- **Indian English**: Native support

**Why not alternatives**:
- PlayHT 3.0: Similar latency, less natural (backup option)
- Google TTS: 400ms+ latency, robotic
- Azure TTS: 350ms+ latency, complex API

**Fallback strategy**: PlayHT 3.0-mini if ElevenLabs quota exceeded

### 3.4 Backend: Node.js + Fastify

**Chosen**: Node.js 20 LTS + Fastify
**Alternatives Considered**: Python (FastAPI), Go, Rust

**Justification**:
- **Event-loop**: Perfect for I/O-bound streaming workloads
- **WebSocket support**: Native, mature libraries (`ws`, `fastify-websocket`)
- **Ecosystem**: Rich STT/TTS SDK support
- **Latency**: Low overhead (Fastify 3x faster than Express)
- **TypeScript**: Type safety for state machine logic
- **Async/await**: Clean concurrency model

**Why not alternatives**:
- Python: GIL limits concurrency, slower event loop
- Go: Harder to find STT/TTS SDKs, overkill for I/O workload
- Rust: Development velocity too slow for iteration

### 3.5 Hosting: AWS Mumbai (ap-south-1)

**Chosen**: AWS EC2 (t3.medium) + Application Load Balancer
**Alternatives Considered**: GCP, Azure, Vercel, Railway

**Justification**:
- **Region**: Mumbai (ap-south-1) for lowest latency to Twilio Mumbai
- **Network**: AWS Direct Connect to Twilio (lower jitter)
- **Scaling**: Auto Scaling Groups for traffic spikes
- **Cost**: $30/month (t3.medium reserved instance)
- **Maturity**: Battle-tested, extensive tooling

**Why not alternatives**:
- GCP: Slightly higher latency to Twilio
- Azure: Limited India region options
- Vercel/Railway: No WebSocket support at scale

### 3.6 Logging: Pino

**Chosen**: Pino
**Alternatives Considered**: Winston, Bunyan

**Justification**:
- **Performance**: 5x faster than Winston (critical for low-latency)
- **Structured**: JSON output for parsing
- **Low overhead**: Async logging, minimal blocking

### 3.7 Metrics: Prometheus + Grafana

**Chosen**: Prometheus (metrics) + Grafana (visualization)
**Alternatives Considered**: Datadog, New Relic, CloudWatch

**Justification**:
- **Latency tracking**: Histogram metrics for percentiles
- **Cost**: Open-source (vs $100+/month for Datadog)
- **Flexibility**: Custom metrics, PromQL queries
- **Grafana**: Rich dashboards for real-time monitoring

### 3.8 LLM: Claude Opus 3.5

**Chosen**: Claude Opus 3.5 (Anthropic)
**Alternatives Considered**: GPT-4, Gemini 1.5 Pro

**Justification**:
- **Structured output**: Native JSON mode for callback notes
- **Context window**: 200K tokens (handles long transcripts)
- **Quality**: Superior reasoning for sentiment analysis
- **Cost**: $15/1M input tokens (cheaper than GPT-4)
- **Latency**: NOT in real-time path (async worker)

**Why not alternatives**:
- GPT-4: More expensive, similar quality
- Gemini 1.5 Pro: Less reliable structured output

---

## 4. Real-Time Conversation Engine Design

### 4.1 State Machine Design

```typescript
enum ConversationState {
  GREETING = 'GREETING',
  ASK_EMPLOYMENT = 'ASK_EMPLOYMENT',
  ASK_SALARY = 'ASK_SALARY',
  ASK_LOCATION = 'ASK_LOCATION',
  ELIGIBLE_CONFIRMATION = 'ELIGIBLE_CONFIRMATION',
  REJECTION = 'REJECTION',
  CLARIFICATION = 'CLARIFICATION',
  DTMF_FALLBACK = 'DTMF_FALLBACK',
  ENDED = 'ENDED'
}

interface ConversationContext {
  callId: string;
  phoneNumber: string;
  currentState: ConversationState;
  eligibility: {
    isSalaried: boolean | null;
    salary: number | null;
    location: string | null;
  };
  turnCount: number;
  clarificationAttempts: number;
  transcript: TranscriptTurn[];
  metrics: LatencyMetrics;
}

interface StateTransition {
  from: ConversationState;
  to: ConversationState;
  condition: (ctx: ConversationContext, input: string) => boolean;
  action: (ctx: ConversationContext, input: string) => Promise<string>;
}
```

### 4.2 State Transition Logic (Pseudo-code)

```typescript
class ConversationStateMachine {
  private context: ConversationContext;
  
  async handleUserInput(transcript: string, confidence: number): Promise<string> {
    // Low confidence handling
    if (confidence < 0.7) {
      return this.handleLowConfidence(transcript);
    }
    
    // State-specific processing
    switch (this.context.currentState) {
      case ConversationState.GREETING:
        return this.handleGreeting();
      
      case ConversationState.ASK_EMPLOYMENT:
        return this.handleEmploymentResponse(transcript);
      
      case ConversationState.ASK_SALARY:
        return this.handleSalaryResponse(transcript);
      
      case ConversationState.ASK_LOCATION:
        return this.handleLocationResponse(transcript);
      
      case ConversationState.ELIGIBLE_CONFIRMATION:
        return this.handleEligibleConfirmation();
      
      case ConversationState.REJECTION:
        return this.handleRejection();
      
      default:
        return this.handleUnexpectedState();
    }
  }
  
  private async handleEmploymentResponse(transcript: string): Promise<string> {
    const isSalaried = EmploymentValidator.validate(transcript);
    this.context.eligibility.isSalaried = isSalaried;
    
    if (isSalaried === null) {
      // Ambiguous response
      this.context.clarificationAttempts++;
      if (this.context.clarificationAttempts > 2) {
        this.context.currentState = ConversationState.DTMF_FALLBACK;
        return "I'm having trouble understanding. Please press 1 if you're a salaried employee, or 2 if not.";
      }
      this.context.currentState = ConversationState.CLARIFICATION;
      return "Just to confirm, are you currently employed on a salary? Please say yes or no.";
    }
    
    if (!isSalaried) {
      this.context.currentState = ConversationState.REJECTION;
      return this.generateRejectionMessage('employment');
    }
    
    // Proceed to salary question
    this.context.currentState = ConversationState.ASK_SALARY;
    this.context.clarificationAttempts = 0;
    return "Great! What is your monthly in-hand salary?";
  }
  
  private async handleSalaryResponse(transcript: string): Promise<string> {
    const salary = SalaryParser.parse(transcript);
    this.context.eligibility.salary = salary;
    
    if (salary === null) {
      this.context.clarificationAttempts++;
      if (this.context.clarificationAttempts > 2) {
        this.context.currentState = ConversationState.DTMF_FALLBACK;
        return "Please enter your monthly salary using the keypad, followed by the hash key.";
      }
      this.context.currentState = ConversationState.CLARIFICATION;
      return "I didn't catch that. Could you tell me your monthly salary in rupees? For example, thirty thousand.";
    }
    
    if (salary < 25000) {
      this.context.currentState = ConversationState.REJECTION;
      return this.generateRejectionMessage('salary');
    }
    
    // Proceed to location question
    this.context.currentState = ConversationState.ASK_LOCATION;
    this.context.clarificationAttempts = 0;
    return "Perfect. Which city do you currently live in?";
  }
  
  private async handleLocationResponse(transcript: string): Promise<string> {
    const location = LocationMatcher.match(transcript);
    this.context.eligibility.location = location;
    
    if (location === null) {
      this.context.clarificationAttempts++;
      if (this.context.clarificationAttempts > 2) {
        this.context.currentState = ConversationState.REJECTION;
        return this.generateRejectionMessage('location_unclear');
      }
      this.context.currentState = ConversationState.CLARIFICATION;
      return "Sorry, I didn't catch that. Do you live in Delhi, Mumbai, or Bangalore?";
    }
    
    const metroCities = ['delhi', 'mumbai', 'bangalore'];
    if (!metroCities.includes(location.toLowerCase())) {
      this.context.currentState = ConversationState.REJECTION;
      return this.generateRejectionMessage('location');
    }
    
    // All criteria met - eligible!
    this.context.currentState = ConversationState.ELIGIBLE_CONFIRMATION;
    await this.saveEligibilityResult(true);
    return "Excellent news! You're eligible for a QuickRupee loan. Our team will call you back within 10 minutes to discuss your options. Thank you!";
  }
}
```

### 4.3 Eligibility Evaluation Logic

```typescript
class EmploymentValidator {
  private static SALARIED_KEYWORDS = ['yes', 'salaried', 'employed', 'job', 'work', 'salary'];
  private static NON_SALARIED_KEYWORDS = ['no', 'self-employed', 'business', 'freelance'];
  
  static validate(transcript: string): boolean | null {
    const normalized = transcript.toLowerCase().trim();
    
    // Direct yes/no
    if (/^(yes|yeah|yep|correct|right)$/i.test(normalized)) return true;
    if (/^(no|nope|not)$/i.test(normalized)) return false;
    
    // Keyword matching
    const hasSalariedKeyword = this.SALARIED_KEYWORDS.some(kw => normalized.includes(kw));
    const hasNonSalariedKeyword = this.NON_SALARIED_KEYWORDS.some(kw => normalized.includes(kw));
    
    if (hasSalariedKeyword && !hasNonSalariedKeyword) return true;
    if (hasNonSalariedKeyword && !hasSalariedKeyword) return false;
    
    // Ambiguous
    return null;
  }
}

class SalaryParser {
  static parse(transcript: string): number | null {
    const normalized = transcript.toLowerCase().trim();
    
    // Direct numeric: "25000", "thirty thousand"
    const directMatch = this.extractNumeric(normalized);
    if (directMatch !== null) return directMatch;
    
    // Contextual: "I earn 30k per month"
    const contextualMatch = this.extractContextual(normalized);
    if (contextualMatch !== null) return contextualMatch;
    
    return null;
  }
  
  private static extractNumeric(text: string): number | null {
    // Digit extraction: "25000" or "25,000"
    const digitMatch = text.match(/(\d{1,3}(?:,\d{3})*|\d+)/);
    if (digitMatch) {
      const num = parseInt(digitMatch[1].replace(/,/g, ''));
      if (num >= 1000 && num <= 1000000) return num;
    }
    
    // Word-to-number: "twenty five thousand"
    const wordMap: Record<string, number> = {
      'thousand': 1000,
      'lakh': 100000,
      'twenty': 20,
      'thirty': 30,
      'forty': 40,
      'fifty': 50,
      // ... full mapping
    };
    
    let total = 0;
    let current = 0;
    
    const words = text.split(/\s+/);
    for (const word of words) {
      if (wordMap[word]) {
        if (wordMap[word] >= 1000) {
          current = (current || 1) * wordMap[word];
          total += current;
          current = 0;
        } else {
          current += wordMap[word];
        }
      }
    }
    
    total += current;
    return total > 0 ? total : null;
  }
  
  private static extractContextual(text: string): number | null {
    // "I make 30k" or "around 40000"
    const patterns = [
      /(?:earn|make|get|salary is)\s*(?:around|about)?\s*(\d+)k?/i,
      /(\d+)\s*(?:thousand|k)\s*(?:rupees|per month)?/i
    ];
    
    for (const pattern of patterns) {
      const match = text.match(pattern);
      if (match) {
        let num = parseInt(match[1]);
        if (text.includes('k') && num < 1000) num *= 1000;
        if (num >= 1000 && num <= 1000000) return num;
      }
    }
    
    return null;
  }
}

class LocationMatcher {
  private static METRO_CITIES = ['delhi', 'mumbai', 'bangalore', 'bengaluru'];
  private static ALIASES: Record<string, string> = {
    'ncr': 'delhi',
    'new delhi': 'delhi',
    'bombay': 'mumbai',
    'bengaluru': 'bangalore',
    'blr': 'bangalore'
  };
  
  static match(transcript: string): string | null {
    const normalized = transcript.toLowerCase().trim();
    
    // Direct match
    for (const city of this.METRO_CITIES) {
      if (normalized.includes(city)) return city;
    }
    
    // Alias match
    for (const [alias, city] of Object.entries(this.ALIASES)) {
      if (normalized.includes(alias)) return city;
    }
    
    // Fuzzy match (Levenshtein distance)
    for (const city of this.METRO_CITIES) {
      if (this.levenshteinDistance(normalized, city) <= 2) return city;
    }
    
    return null;
  }
  
  private static levenshteinDistance(a: string, b: string): number {
    const matrix: number[][] = [];
    
    for (let i = 0; i <= b.length; i++) {
      matrix[i] = [i];
    }
    
    for (let j = 0; j <= a.length; j++) {
      matrix[0][j] = j;
    }
    
    for (let i = 1; i <= b.length; i++) {
      for (let j = 1; j <= a.length; j++) {
        if (b.charAt(i - 1) === a.charAt(j - 1)) {
          matrix[i][j] = matrix[i - 1][j - 1];
        } else {
          matrix[i][j] = Math.min(
            matrix[i - 1][j - 1] + 1,
            matrix[i][j - 1] + 1,
            matrix[i - 1][j] + 1
          );
        }
      }
    }
    
    return matrix[b.length][a.length];
  }
}
```

### 4.4 Barge-In Handling

```typescript
class BargeInDetector {
  private readonly VAD_THRESHOLD = 0.5; // Voice activity threshold
  private readonly MIN_INTERRUPT_DURATION = 300; // ms
  
  async detectInterrupt(audioChunk: Buffer, isBotSpeaking: boolean): Promise<boolean> {
    if (!isBotSpeaking) return false;
    
    // Use Deepgram interim results for VAD
    const interimResult = await this.sttClient.getInterimResult(audioChunk);
    
    if (interimResult.isFinal === false && interimResult.confidence > this.VAD_THRESHOLD) {
      // User is speaking while bot is speaking
      return true;
    }
    
    return false;
  }
  
  async handleInterrupt(context: ConversationContext): Promise<void> {
    // Stop TTS immediately
    await this.ttsClient.stopStreaming();
    
    // Clear Twilio audio buffer
    await this.twilioClient.clearAudioQueue(context.callId);
    
    // Reset to listening mode
    context.currentState = ConversationState.CLARIFICATION;
    
    // Log interrupt event
    this.metrics.recordInterrupt(context.callId);
  }
}
```

---

## 5. Voice Warmth & UX Strategy

### 5.1 Conversational Tone Principles

**Warmth Characteristics:**
- **Empathetic**: Acknowledge user's time ("Thank you for calling")
- **Encouraging**: Positive framing ("Great!", "Perfect!")
- **Patient**: Never rush, allow pauses
- **Respectful**: Use "please", "thank you"
- **Clear**: Avoid jargon, use simple language

**Anti-Patterns to Avoid:**
- Robotic phrasing ("Please hold while I process")
- Over-formality ("Your request has been received")
- Excessive apologies ("Sorry, sorry, sorry")
- Rushed speech (no pauses between sentences)

### 5.2 Micro-Acknowledgements

**Purpose**: Signal active listening, reduce user anxiety

**Implementation**:
```typescript
const ACKNOWLEDGEMENTS = [
  "I see",
  "Got it",
  "Understood",
  "Okay",
  "Mm-hmm"
];

function generateAcknowledgement(context: ConversationContext): string {
  // Use sparingly (every 2-3 turns)
  if (context.turnCount % 3 === 0) {
    return ACKNOWLEDGEMENTS[Math.floor(Math.random() * ACKNOWLEDGEMENTS.length)];
  }
  return '';
}
```

**Placement**: Before transitioning to next question
- User: "Yes, I'm salaried"
- Bot: "Got it. <pause> What is your monthly in-hand salary?"

### 5.3 Prosody Control (SSML)

```typescript
function generateSSML(text: string, emotion: 'neutral' | 'encouraging' | 'empathetic'): string {
  const baseSSML = `<speak>${text}</speak>`;
  
  switch (emotion) {
    case 'encouraging':
      return `<speak><prosody rate="medium" pitch="+5%">${text}</prosody></speak>`;
    
    case 'empathetic':
      return `<speak><prosody rate="slow" pitch="-3%">${text}</prosody></speak>`;
    
    default:
      return baseSSML;
  }
}

// Usage
const greeting = generateSSML(
  "Hi! Thank you for calling QuickRupee. <break time='500ms'/> I'll ask you a few quick questions to check your eligibility.",
  'empathetic'
);
```

**Pause Strategy**:
- After greeting: 500ms
- Between questions: 300ms
- After acknowledgement: 200ms
- Before rejection: 400ms (soften blow)

### 5.4 Accent Switching Mechanism

**Configuration**:
```typescript
interface VoiceProfile {
  provider: 'elevenlabs' | 'playht';
  voiceId: string;
  accent: 'indian-english' | 'neutral-english';
  gender: 'male' | 'female';
  stability: number; // 0-1
  similarityBoost: number; // 0-1
}

const VOICE_PROFILES: Record<string, VoiceProfile> = {
  'default': {
    provider: 'elevenlabs',
    voiceId: 'pNInz6obpgDQGcFmaJgB', // ElevenLabs Adam (Indian English)
    accent: 'indian-english',
    gender: 'male',
    stability: 0.7,
    similarityBoost: 0.8
  },
  'female-warm': {
    provider: 'elevenlabs',
    voiceId: 'EXAVITQu4vr4xnSDxMaL', // ElevenLabs Bella
    accent: 'indian-english',
    gender: 'female',
    stability: 0.8,
    similarityBoost: 0.75
  }
};

// Runtime switching
class VoiceManager {
  private currentProfile: VoiceProfile;
  
  async switchVoice(profileName: string): Promise<void> {
    this.currentProfile = VOICE_PROFILES[profileName];
    await this.ttsClient.updateVoiceSettings(this.currentProfile);
  }
  
  // A/B testing support
  async selectVoiceForCall(callId: string): Promise<VoiceProfile> {
    const hash = this.hashCallId(callId);
    return hash % 2 === 0 ? VOICE_PROFILES['default'] : VOICE_PROFILES['female-warm'];
  }
}
```

---

## 6. Observability & Metrics

### 6.1 Latency Instrumentation

```typescript
interface LatencyMetrics {
  callId: string;
  turnId: string;
  timestamps: {
    userSpeechEnd: number;
    sttFirstToken: number;
    sttFinalTranscript: number;
    logicEvaluationStart: number;
    logicEvaluationEnd: number;
    ttsRequestSent: number;
    ttsFirstByte: number;
    ttsComplete: number;
    audioPlaybackStart: number;
  };
  durations: {
    sttLatency: number;
    logicLatency: number;
    ttsLatency: number;
    totalTurnLatency: number;
  };
}

class MetricsCollector {
  private prometheus: PrometheusClient;
  
  // Histogram for latency percentiles
  private turnLatencyHistogram = new this.prometheus.Histogram({
    name: 'voice_bot_turn_latency_ms',
    help: 'End-to-end turn latency',
    buckets: [100, 200, 300, 500, 800, 1000, 1500, 2000, 3000]
  });
  
  private sttLatencyHistogram = new this.prometheus.Histogram({
    name: 'voice_bot_stt_latency_ms',
    help: 'STT first token latency',
    buckets: [50, 100, 150, 200, 300, 500, 800]
  });
  
  private ttsLatencyHistogram = new this.prometheus.Histogram({
    name: 'voice_bot_tts_latency_ms',
    help: 'TTS first byte latency',
    buckets: [100, 200, 300, 500, 800, 1000]
  });
  
  recordTurnLatency(metrics: LatencyMetrics): void {
    this.turnLatencyHistogram.observe(metrics.durations.totalTurnLatency);
    this.sttLatencyHistogram.observe(metrics.durations.sttLatency);
    this.ttsLatencyHistogram.observe(metrics.durations.ttsLatency);
    
    // Structured logging
    logger.info({
      event: 'turn_completed',
      callId: metrics.callId,
      turnId: metrics.turnId,
      latency: metrics.durations,
      timestamps: metrics.timestamps
    });
  }
}
```

### 6.2 Logging Format

```json
{
  "timestamp": "2026-02-14T14:17:32.123Z",
  "level": "info",
  "event": "turn_completed",
  "callId": "CA1234567890abcdef",
  "turnId": "turn_003",
  "state": "ASK_SALARY",
  "transcript": {
    "user": "thirty thousand rupees",
    "bot": "Perfect. Which city do you currently live in?",
    "confidence": 0.92
  },
  "latency": {
    "sttLatency": 187,
    "logicLatency": 8,
    "ttsLatency": 223,
    "totalTurnLatency": 418
  },
  "eligibility": {
    "isSalaried": true,
    "salary": 30000,
    "location": null
  }
}
```

### 6.3 Metrics Endpoint

**Prometheus Scrape Endpoint**: `GET /metrics`

**Sample Output**:
```
# HELP voice_bot_turn_latency_ms End-to-end turn latency
# TYPE voice_bot_turn_latency_ms histogram
voice_bot_turn_latency_ms_bucket{le="100"} 0
voice_bot_turn_latency_ms_bucket{le="200"} 12
voice_bot_turn_latency_ms_bucket{le="300"} 45
voice_bot_turn_latency_ms_bucket{le="500"} 89
voice_bot_turn_latency_ms_bucket{le="800"} 102
voice_bot_turn_latency_ms_bucket{le="1000"} 108
voice_bot_turn_latency_ms_bucket{le="+Inf"} 112
voice_bot_turn_latency_ms_sum 52340
voice_bot_turn_latency_ms_count 112

# HELP voice_bot_calls_total Total calls handled
# TYPE voice_bot_calls_total counter
voice_bot_calls_total{status="completed"} 87
voice_bot_calls_total{status="eligible"} 34
voice_bot_calls_total{status="rejected"} 53
voice_bot_calls_total{status="error"} 3
```

### 6.4 Grafana Dashboard

**Panels**:
1. **Turn Latency (P50, P95, P99)**: Line graph over time
2. **Component Latency Breakdown**: Stacked area chart (STT, Logic, TTS)
3. **Call Volume**: Counter (total, eligible, rejected)
4. **Error Rate**: Percentage of failed calls
5. **Confidence Score Distribution**: Histogram
6. **Barge-In Rate**: Percentage of interrupted turns

---

## 7. Deployment Strategy

### 7.1 Hosting Environment

**Infrastructure**:
- **Provider**: AWS
- **Region**: ap-south-1 (Mumbai)
- **Compute**: EC2 t3.medium (2 vCPU, 4GB RAM)
- **Load Balancer**: Application Load Balancer (ALB)
- **Auto Scaling**: Target tracking (CPU > 70%)
- **Database**: Neon PostgreSQL (Mumbai region)
- **Cache/Queue**: ElastiCache Redis (cache.t3.micro)

**Scaling Configuration**:
```yaml
AutoScalingGroup:
  MinSize: 2
  MaxSize: 10
  TargetCPUUtilization: 70%
  ScaleUpCooldown: 60s
  ScaleDownCooldown: 300s
```

**Concurrent Call Capacity**:
- Per instance: ~50 concurrent calls (WebSocket connections)
- Cluster (2 instances): 100 calls
- Max (10 instances): 500 calls

### 7.2 WebSocket Handling

**Load Balancer Configuration**:
```nginx
# ALB Target Group
Protocol: HTTP
Port: 3000
HealthCheck: /health
Stickiness: Enabled (session-based)
IdleTimeout: 3600s

# WebSocket upgrade
Connection: Upgrade
Upgrade: websocket
```

**Connection Management**:
```typescript
class WebSocketManager {
  private connections: Map<string, WebSocket> = new Map();
  
  async handleConnection(ws: WebSocket, callId: string): Promise<void> {
    this.connections.set(callId, ws);
    
    // Heartbeat to prevent idle timeout
    const heartbeat = setInterval(() => {
      if (ws.readyState === WebSocket.OPEN) {
        ws.ping();
      }
    }, 30000); // 30s
    
    ws.on('close', () => {
      clearInterval(heartbeat);
      this.connections.delete(callId);
    });
  }
}
```

### 7.3 Environment Configuration

```bash
# .env.production
NODE_ENV=production
PORT=3000
LOG_LEVEL=info

# Twilio
TWILIO_ACCOUNT_SID=ACxxxx
TWILIO_AUTH_TOKEN=xxxx
TWILIO_PHONE_NUMBER=+91xxxxxxxxxx

# Deepgram
DEEPGRAM_API_KEY=xxxx
DEEPGRAM_MODEL=nova-2
DEEPGRAM_LANGUAGE=en-IN

# ElevenLabs
ELEVENLABS_API_KEY=xxxx
ELEVENLABS_VOICE_ID=pNInz6obpgDQGcFmaJgB
ELEVENLABS_MODEL=eleven_turbo_v2_5

# Database
DATABASE_URL=postgresql://user:pass@neon.tech:5432/quickrupee

# Redis
REDIS_URL=redis://elasticache.ap-south-1.amazonaws.com:6379

# Claude
ANTHROPIC_API_KEY=sk-ant-xxxx
CLAUDE_MODEL=claude-opus-3-5-20250514

# Metrics
PROMETHEUS_PORT=9090
```

### 7.4 Deployment Pipeline

```yaml
# GitHub Actions
name: Deploy to Production

on:
  push:
    branches: [main]

jobs:
  deploy:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v3
      
      - name: Build Docker image
        run: docker build -t voice-bot:${{ github.sha }} .
      
      - name: Push to ECR
        run: |
          aws ecr get-login-password | docker login --username AWS --password-stdin
          docker tag voice-bot:${{ github.sha }} ecr.ap-south-1.amazonaws.com/voice-bot:latest
          docker push ecr.ap-south-1.amazonaws.com/voice-bot:latest
      
      - name: Deploy to ECS
        run: |
          aws ecs update-service --cluster voice-bot --service voice-bot --force-new-deployment
      
      - name: Health check
        run: |
          sleep 60
          curl -f https://voice-bot.quickrupee.com/health || exit 1
```

---

## 8. Claude Usage Strategy

### 8.1 Why LLM is NOT in Real-Time Loop

**Rationale**:
- **Latency**: Claude Opus has 500-2000ms response time (unacceptable for <500ms target)
- **Determinism**: Eligibility logic is binary (no reasoning needed)
- **Cost**: $0.015 per call (vs $0.001 for deterministic logic)
- **Reliability**: LLM can hallucinate, miss numeric parsing

**Deterministic Logic Advantages**:
- **Predictable**: Same input → same output
- **Fast**: <10ms execution
- **Testable**: Unit tests for all edge cases
- **Debuggable**: Clear failure modes

### 8.2 Where Claude Opus is Used

**Post-Call Processing** (Async Worker):

1. **Callback Note Generation**
   - Input: Full transcript + eligibility result
   - Output: Structured note for sales team
   - Latency: Not critical (processed in background)

2. **Sentiment Analysis**
   - Input: Transcript
   - Output: Sentiment score (positive/neutral/negative)
   - Use case: Quality monitoring

3. **Conversation Quality Scoring**
   - Input: Transcript + latency metrics
   - Output: Quality score (1-10)
   - Use case: Bot performance optimization

### 8.3 Post-Call Callback Note Generation

**Workflow**:
```
Call Ends → Save to DB → Enqueue Job → Worker Picks Up → Call Claude → Save Note
```

**BullMQ Job**:
```typescript
interface CallbackNoteJob {
  callId: string;
  transcript: TranscriptTurn[];
  eligibilityResult: {
    eligible: boolean;
    isSalaried: boolean;
    salary: number;
    location: string;
  };
  phoneNumber: string;
}

async function processCallbackNote(job: CallbackNoteJob): Promise<void> {
  const prompt = `
You are a sales assistant for QuickRupee. Generate a concise callback note for the sales team based on this loan screening call.

TRANSCRIPT:
${job.transcript.map(t => `${t.speaker}: ${t.text}`).join('\n')}

ELIGIBILITY RESULT:
- Eligible: ${job.eligibilityResult.eligible}
- Employment: ${job.eligibilityResult.isSalaried ? 'Salaried' : 'Not salaried'}
- Salary: ₹${job.eligibilityResult.salary}
- Location: ${job.eligibilityResult.location}

Generate a JSON response with:
{
  "summary": "2-3 sentence summary for sales team",
  "urgency": "high|medium|low",
  "recommendedAction": "specific next step",
  "customerSentiment": "positive|neutral|negative",
  "notes": "any additional context"
}
`;

  const response = await anthropic.messages.create({
    model: 'claude-opus-3-5-20250514',
    max_tokens: 500,
    messages: [{ role: 'user', content: prompt }]
  });
  
  const note = JSON.parse(response.content[0].text);
  
  await db.callbackNotes.create({
    callId: job.callId,
    phoneNumber: job.phoneNumber,
    summary: note.summary,
    urgency: note.urgency,
    recommendedAction: note.recommendedAction,
    sentiment: note.customerSentiment,
    notes: note.notes,
    createdAt: new Date()
  });
}
```

### 8.4 Structured Output Schema

```typescript
interface CallbackNote {
  summary: string; // "Eligible candidate, salaried at ₹35k/month in Mumbai. Positive interaction."
  urgency: 'high' | 'medium' | 'low';
  recommendedAction: string; // "Call within 10 minutes to discuss loan options"
  customerSentiment: 'positive' | 'neutral' | 'negative';
  notes: string; // "Customer mentioned urgent need for funds"
}
```

### 8.5 Rate Limiting Strategy

**Anthropic Limits**:
- Tier 1: 50 requests/min
- Tier 2: 1000 requests/min

**Implementation**:
```typescript
class ClaudeRateLimiter {
  private queue: Queue;
  private readonly MAX_CONCURRENT = 10;
  private readonly RATE_LIMIT = 50; // requests/min
  
  async enqueueJob(job: CallbackNoteJob): Promise<void> {
    await this.queue.add('generate-note', job, {
      attempts: 3,
      backoff: {
        type: 'exponential',
        delay: 2000
      },
      limiter: {
        max: this.RATE_LIMIT,
        duration: 60000 // 1 minute
      }
    });
  }
}
```

---

## 9. Risk Analysis & Mitigation

### 9.1 STT Misrecognition Risks

**Risk**: User says "yes" but STT transcribes "yeah" or "yep"

**Mitigation**:
- Keyword matching with synonyms (yes/yeah/yep/correct)
- Confidence threshold (>0.7 required)
- Clarification loop (max 2 attempts)
- DTMF fallback for persistent failures

**Risk**: Numeric misrecognition ("thirty" → "thirteen")

**Mitigation**:
- Contextual validation (salary must be >₹10k, <₹10L)
- Clarification if out of range
- DTMF fallback for salary input

### 9.2 Accent Issues

**Risk**: Indian English accent variations (Delhi vs Chennai)

**Mitigation**:
- Use Deepgram's Indian English model (trained on regional accents)
- Fuzzy matching for location names
- Clarification prompts with examples

**Risk**: Code-switching (Hindi-English mix)

**Mitigation**:
- Deepgram supports Hindi detection
- Prompt user to respond in English if detected
- Escalate to human agent if persistent

### 9.3 Network Jitter

**Risk**: Packet loss causes audio dropouts

**Mitigation**:
- Adaptive buffering (50-200ms)
- Jitter buffer in Twilio
- Monitor packet loss metrics, retry if >5%

**Risk**: WebSocket disconnection mid-call

**Mitigation**:
- Automatic reconnection with exponential backoff
- Save conversation state to Redis (recover on reconnect)
- Graceful degradation (fallback to webhook gather)

### 9.4 Twilio Streaming Failure

**Risk**: Twilio media stream API downtime

**Mitigation**:
- Fallback to TwiML `<Gather>` (non-streaming)
- Health check endpoint monitors Twilio status
- Alert ops team if failure rate >1%

**Risk**: Regional outage (Mumbai)

**Mitigation**:
- Multi-region deployment (Mumbai primary, Singapore secondary)
- DNS failover (Route 53 health checks)
- Degrade to webhook-only mode

### 9.5 Cold Start Latency

**Risk**: First call after deploy has 2-3s latency (container cold start)

**Mitigation**:
- Keep-alive requests every 5 minutes
- Pre-warm containers on deploy
- Use AWS Lambda SnapStart (if migrating to Lambda)

**Risk**: STT/TTS API cold start

**Mitigation**:
- Persistent WebSocket connections to Deepgram/ElevenLabs
- Connection pooling
- Reconnect on idle timeout

### 9.6 Data Privacy Risks

**Risk**: Storing sensitive PII (phone numbers, salary)

**Mitigation**:
- Encrypt PII at rest (AES-256)
- Mask phone numbers in logs (last 4 digits only)
- GDPR compliance (data retention policy: 90 days)
- Secure API keys in AWS Secrets Manager

---

## 10. Development Phases

### Phase 1: Core Streaming Skeleton (Week 1)

**Deliverables**:
- [ ] Twilio WebSocket integration
- [ ] Deepgram STT streaming
- [ ] ElevenLabs TTS streaming
- [ ] Basic echo bot (repeat user input)
- [ ] Latency instrumentation (console logs)
- [ ] Docker containerization

**Success Criteria**:
- Bidirectional audio streaming works
- Sub-1s echo latency
- No audio dropouts

**Tech Stack**:
- Node.js 20 + TypeScript
- Fastify + `fastify-websocket`
- Deepgram SDK
- ElevenLabs SDK
- Twilio SDK

### Phase 2: Eligibility Engine (Week 2)

**Deliverables**:
- [ ] State machine implementation
- [ ] Employment validator
- [ ] Salary parser (numeric + word-to-number)
- [ ] Location matcher (fuzzy)
- [ ] PostgreSQL schema + migrations
- [ ] Eligibility result persistence

**Success Criteria**:
- All 3 questions asked in sequence
- Correct eligibility determination (100% accuracy on test cases)
- <10ms logic evaluation latency

**Test Cases**:
- Salaried, ₹30k, Mumbai → Eligible
- Self-employed, ₹40k, Delhi → Rejected (employment)
- Salaried, ₹20k, Bangalore → Rejected (salary)
- Salaried, ₹35k, Pune → Rejected (location)

### Phase 3: Voice & UX Tuning (Week 3)

**Deliverables**:
- [ ] SSML prosody control
- [ ] Micro-acknowledgements
- [ ] Pause insertion
- [ ] Voice profile configuration
- [ ] Barge-in handling
- [ ] Clarification loops
- [ ] DTMF fallback

**Success Criteria**:
- Voice sounds warm and natural (user testing)
- Barge-in works without audio artifacts
- Clarification loop resolves ambiguity

**User Testing**:
- 10 test calls with internal team
- Collect feedback on warmth, clarity, pacing

### Phase 4: Metrics & Instrumentation (Week 4)

**Deliverables**:
- [ ] Prometheus metrics export
- [ ] Grafana dashboards
- [ ] Structured logging (Pino)
- [ ] Error tracking (Sentry)
- [ ] Call recording (Twilio)
- [ ] Transcript storage

**Success Criteria**:
- All latency metrics visible in Grafana
- P95 turn latency <700ms
- Error rate <1%

**Dashboards**:
- Real-time latency (P50, P95, P99)
- Call volume (total, eligible, rejected)
- Error rate
- Confidence score distribution

### Phase 5: Production Hardening (Week 5)

**Deliverables**:
- [ ] AWS deployment (EC2 + ALB)
- [ ] Auto Scaling configuration
- [ ] Multi-region failover
- [ ] Claude Opus integration (async worker)
- [ ] Rate limiting
- [ ] Security hardening (API key rotation, encryption)
- [ ] Load testing (100 concurrent calls)
- [ ] Runbook documentation

**Success Criteria**:
- System handles 100 concurrent calls
- 99.9% uptime
- Auto-scaling works under load
- Callback notes generated within 60s of call end

**Load Testing**:
- Tool: Artillery.io
- Scenario: Ramp from 0 → 100 calls over 5 minutes
- Metrics: Latency, error rate, CPU/memory usage

---

## Appendix A: Sample Call Flow

**Scenario**: Eligible candidate

```
[Call connects]

Bot: "Hi! Thank you for calling QuickRupee. I'll ask you a few quick questions to check your eligibility. Are you currently a salaried employee?"

User: "Yes, I am."

Bot: "Got it. What is your monthly in-hand salary?"

User: "Thirty-five thousand rupees."

Bot: "Perfect. Which city do you currently live in?"

User: "Mumbai."

Bot: "Excellent news! You're eligible for a QuickRupee loan. Our team will call you back within 10 minutes to discuss your options. Thank you!"

[Call ends]
```

**Latency Breakdown**:
- Turn 1 (employment): 420ms
- Turn 2 (salary): 480ms
- Turn 3 (location): 450ms
- Average: 450ms ✅

---

## Appendix B: Technology Alternatives Comparison

| Category | Chosen | Alternative 1 | Alternative 2 | Rationale |
|----------|--------|---------------|---------------|-----------|
| **STT** | Deepgram Nova-2 | Google STT | AssemblyAI | Lowest latency (150ms), streaming, Indian English |
| **TTS** | ElevenLabs Turbo | PlayHT 3.0 | Google TTS | Best naturalness + low latency (200ms) |
| **Backend** | Node.js + Fastify | Python + FastAPI | Go | Event-loop perfect for I/O, rich ecosystem |
| **Hosting** | AWS Mumbai | GCP Mumbai | Azure India | Lowest latency to Twilio, mature tooling |
| **DB** | PostgreSQL (Neon) | MongoDB | DynamoDB | Relational data, ACID guarantees |
| **Queue** | BullMQ + Redis | RabbitMQ | AWS SQS | Native Node.js support, low latency |
| **LLM** | Claude Opus 3.5 | GPT-4 | Gemini 1.5 Pro | Best structured output, cost-effective |

---

## Appendix C: Cost Estimation

**Per-Call Costs** (3-minute call):
- Twilio inbound: $0.0085/min × 3 = $0.0255
- Deepgram STT: $0.0043/min × 3 = $0.0129
- ElevenLabs TTS: $0.18/1K chars × ~500 chars = $0.09
- Claude Opus (post-call): $0.015/1K tokens × ~2K tokens = $0.03
- **Total**: ~$0.16 per call

**Monthly Costs** (1000 calls/month):
- Per-call: $160
- Infrastructure (AWS): $100
- Database (Neon): $25
- Redis (ElastiCache): $15
- **Total**: ~$300/month

**Scaling** (10K calls/month):
- Per-call: $1,600
- Infrastructure: $300
- Database: $50
- Redis: $25
- **Total**: ~$2,000/month

---

## Conclusion

This development plan provides a production-grade blueprint for a low-latency, human-like voice screening system. The architecture prioritizes:

1. **Latency**: Sub-500ms turn latency via streaming STT/TTS
2. **Determinism**: Business logic outside LLM path
3. **Warmth**: Natural voice, prosody control, micro-acknowledgements
4. **Observability**: Comprehensive metrics and logging
5. **Scalability**: Auto-scaling, multi-region failover
6. **Cost-efficiency**: $0.16/call, $300/month for 1K calls

The phased development approach ensures incremental validation, with each phase building on the previous. Claude Opus is strategically used for post-call processing, avoiding real-time latency penalties.

This system is ready for Claude Opus implementation.
