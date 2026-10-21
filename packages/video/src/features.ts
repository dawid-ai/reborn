import { SpectrumAnalyzer } from '@reborn/analysis'

// Per-video-frame audio envelopes from the rendered mix: band energies, level,
// and a high-frequency onset envelope. Each is normalized so its 98th
// percentile reads 1 and smoothed with a fast-attack, slow-release follower,
// so motion follows the sound without flicker.

export const BANDS = { sub: [20, 60], bass: [60, 250], mid: [250, 2000], harsh: [2000, 6000], air: [6000, 20000] } as const
export type Band = keyof typeof BANDS
export type FeatureName = Band | 'rms' | 'hatEnv'

export interface AudioFeatures {
  fps: number
  frames: number
  values: Record<FeatureName, Float32Array>
  /** The mix as mono samples, for the waveform texture. */
  mono: Float32Array
  sampleRate: number
  /** 99.9th percentile of |sample|, used to scale the waveform. */
  peak: number
}

const FFT_SIZE = 4096
// SpectrumAnalyzer reports amplitude; this restores the raw FFT magnitude the
// prototype's thresholds were tuned against.
const RAW_SCALE = FFT_SIZE / 4

function percentile(values: ArrayLike<number>, p: number): number {
  const sorted = Float32Array.from(values).sort()
  if (!sorted.length) return 0
  return sorted[Math.min(sorted.length - 1, Math.floor((p / 100) * (sorted.length - 1)))]
}

function normalize(values: Float32Array, p = 98, max = 1.5): Float32Array {
  const ref = percentile(values, p) + 1e-9
  return values.map((v) => Math.min(max, Math.max(0, v / ref)))
}

function follow(values: Float32Array, attack = 0.6, release = 0.12): Float32Array {
  const out = new Float32Array(values.length)
  let s = 0
  for (let i = 0; i < values.length; i += 1) {
    const v = values[i]
    s += (v - s) * (v > s ? attack : release)
    out[i] = s
  }
  return out
}

function median9(values: Float32Array): Float32Array {
  const out = new Float32Array(values.length)
  const window: number[] = []
  for (let i = 0; i < values.length; i += 1) {
    window.length = 0
    for (let k = i - 4; k <= i + 4; k += 1) window.push(k >= 0 && k < values.length ? values[k] : 0)
    window.sort((a, z) => a - z)
    out[i] = window[4]
  }
  return out
}

/** Mixes channels to mono. */
export function toMono(channels: readonly Float32Array[]): Float32Array {
  const length = Math.max(...channels.map((c) => c.length))
  const mono = new Float32Array(length)
  for (const channel of channels) for (let i = 0; i < channel.length; i += 1) mono[i] += channel[i] / channels.length
  return mono
}

/** Analyzes a mix. Yields to the event loop between blocks so the UI stays responsive. */
export async function analyzeMix(channels: readonly Float32Array[], sampleRate: number, fps: number, options: { signal?: AbortSignal; onProgress?: (done: number, total: number) => void } = {}): Promise<AudioFeatures> {
  const mono = toMono(channels)
  const hop = sampleRate / fps
  const frames = Math.ceil(mono.length / hop)
  const analyzer = new SpectrumAnalyzer(FFT_SIZE)
  const mags = new Float64Array(analyzer.binCount)
  const prevLog = new Float64Array(analyzer.binCount)
  const segment = new Float64Array(FFT_SIZE)
  const binHz = sampleRate / FFT_SIZE
  const bandBins = Object.fromEntries(Object.entries(BANDS).map(([name, [lo, hi]]) => [name, [Math.ceil(lo / binHz), Math.min(analyzer.binCount, Math.ceil(hi / binHz))]])) as Record<Band, [number, number]>
  const hiBin = Math.ceil(2000 / binHz)
  const raw = Object.fromEntries([...Object.keys(BANDS), 'rms', 'hatEnv'].map((k) => [k, new Float32Array(frames)])) as Record<FeatureName, Float32Array>

  for (let f = 0; f < frames; f += 1) {
    if (f % 256 === 0) {
      if (options.signal?.aborted) throw new DOMException('Analysis cancelled.', 'AbortError')
      options.onProgress?.(f, frames)
      await new Promise<void>((resolve) => setTimeout(resolve, 0))
    }
    const center = Math.round(f * hop)
    const begin = center - FFT_SIZE / 2
    let sum = 0
    for (let i = 0; i < FFT_SIZE; i += 1) {
      const v = mono[begin + i] ?? 0
      segment[i] = v
      if (i >= FFT_SIZE / 4 && i < (FFT_SIZE * 3) / 4) sum += v * v
    }
    raw.rms[f] = Math.sqrt(sum / (FFT_SIZE / 2))
    analyzer.magnitudes(segment, 0, mags)
    for (const band of Object.keys(BANDS) as Band[]) {
      const [lo, hi] = bandBins[band]
      let power = 0
      for (let k = lo; k < hi; k += 1) power += (mags[k] * RAW_SCALE) ** 2
      raw[band][f] = Math.sqrt(power / Math.max(1, hi - lo))
    }
    let flux = 0
    for (let k = 0; k < mags.length; k += 1) {
      const log = Math.log1p(mags[k] * RAW_SCALE * 10)
      if (f > 0 && k >= hiBin) flux += Math.max(0, log - prevLog[k])
      prevLog[k] = log
    }
    raw.hatEnv[f] = flux
  }

  const values = {} as Record<FeatureName, Float32Array>
  for (const band of Object.keys(BANDS) as Band[]) values[band] = follow(normalize(raw[band]))
  values.rms = follow(normalize(raw.rms))
  const median = median9(raw.hatEnv)
  values.hatEnv = follow(normalize(raw.hatEnv.map((v, i) => Math.max(0, v - median[i])), 99, 1), 1, 0.25)
  options.onProgress?.(frames, frames)
  return { fps, frames, values, mono, sampleRate, peak: percentile(mono.map(Math.abs), 99.9) || 1 }
}

/** Reads a feature at a time in seconds; 0 when there is no analysis yet. */
export function featureAt(features: AudioFeatures | null, name: FeatureName, t: number): number {
  if (!features) return 0
  const values = features.values[name]
  const i = Math.min(values.length - 1, Math.max(0, Math.round(t * features.fps)))
  return values[i] ?? 0
}

const spectrumAnalyzer = new SpectrumAnalyzer(FFT_SIZE)
const spectrumMags = new Float64Array(spectrumAnalyzer.binCount)
const spectrumSegment = new Float64Array(FFT_SIZE)

/**
 * The 512 x 2 texture the looks read as uWave: row 0 is the waveform around t
 * (-1 to 1), row 1 is a log-frequency spectrum from 30 Hz to 16 kHz (0 to 1).
 */
export function waveRows(features: AudioFeatures | null, t: number, out = new Float32Array(1024)): Float32Array {
  if (!features) return out.fill(0)
  const { mono, sampleRate, peak } = features
  const center = Math.floor(t * sampleRate)
  spectrumSegment.fill(0)
  for (let i = 0; i < 1024; i += 1) {
    const v = mono[center - 512 + i] ?? 0
    spectrumSegment[i] = v
    if (i % 2 === 0) out[i / 2] = Math.max(-1.2, Math.min(1.2, v / peak))
  }
  spectrumAnalyzer.magnitudes(spectrumSegment, 0, spectrumMags)
  const binHz = sampleRate / FFT_SIZE
  for (let i = 0; i < 512; i += 1) {
    const hz = 30 * (16000 / 30) ** (i / 511)
    const pos = hz / binHz
    const k = Math.floor(pos)
    const frac = pos - k
    const mag = ((spectrumMags[k] ?? 0) * (1 - frac) + (spectrumMags[k + 1] ?? 0) * frac) * RAW_SCALE
    out[512 + i] = Math.min(1, Math.max(0, (20 * Math.log10(mag + 1e-6) + 20) / 60))
  }
  return out
}
