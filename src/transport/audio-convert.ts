/**
 * Audio conversion utilities for browser/local transport.
 * All functions are pure and stream-chunk friendly.
 */

const MU_LAW_BIAS = 0x84;
const MU_LAW_CLIP = 32635;

export function float32ToPcm16(input: Float32Array): Int16Array {
    const output = new Int16Array(input.length);
    for (let i = 0; i < input.length; i++) {
        const clamped = Math.max(-1, Math.min(1, input[i] ?? 0));
        output[i] = clamped < 0 ? Math.round(clamped * 32768) : Math.round(clamped * 32767);
    }
    return output;
}

export function downsamplePcm16Mono(input: Int16Array, inputSampleRate: number, targetSampleRate: number): Int16Array {
    if (targetSampleRate > inputSampleRate) {
        throw new Error(`Target sample rate ${targetSampleRate} cannot exceed input sample rate ${inputSampleRate}`);
    }
    if (targetSampleRate === inputSampleRate) {
        return input;
    }

    const ratio = inputSampleRate / targetSampleRate;
    const outputLength = Math.max(1, Math.floor(input.length / ratio));
    const output = new Int16Array(outputLength);

    let outputIndex = 0;
    let inputIndex = 0;

    while (outputIndex < outputLength) {
        const nextInputIndex = Math.min(input.length, Math.floor((outputIndex + 1) * ratio));
        let sum = 0;
        let count = 0;

        for (let i = Math.floor(inputIndex); i < nextInputIndex; i++) {
            sum += input[i] ?? 0;
            count++;
        }

        output[outputIndex] = count > 0 ? Math.round(sum / count) : 0;
        outputIndex++;
        inputIndex = nextInputIndex;
    }

    return output;
}

export function interleavedToMonoPcm16(input: Int16Array, channels: number): Int16Array {
    if (channels <= 1) {
        return input;
    }

    const frames = Math.floor(input.length / channels);
    const output = new Int16Array(frames);

    for (let frame = 0; frame < frames; frame++) {
        let sum = 0;
        for (let channel = 0; channel < channels; channel++) {
            sum += input[(frame * channels) + channel] ?? 0;
        }
        output[frame] = Math.round(sum / channels);
    }

    return output;
}

export function pcm16ToMulaw(input: Int16Array): Buffer {
    const output = Buffer.allocUnsafe(input.length);

    for (let i = 0; i < input.length; i++) {
        output[i] = linearToMulaw(input[i] ?? 0);
    }

    return output;
}

function linearToMulaw(sample: number): number {
    let pcm = sample;
    let sign = (pcm >> 8) & 0x80;

    if (sign !== 0) {
        pcm = -pcm;
    }

    if (pcm > MU_LAW_CLIP) {
        pcm = MU_LAW_CLIP;
    }

    pcm += MU_LAW_BIAS;

    let exponent = 7;
    for (let expMask = 0x4000; (pcm & expMask) === 0 && exponent > 0; exponent--, expMask >>= 1) {
        // no-op
    }

    const mantissa = (pcm >> (exponent + 3)) & 0x0f;
    const mulaw = ~(sign | (exponent << 4) | mantissa);

    return mulaw & 0xff;
}
