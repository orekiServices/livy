/**
 * Named training presets — "more automix models", without changing the
 * transition set or the model's feature/action columns.
 *
 * A preset is only an architecture and a budget. Everything else (features,
 * actions, loss, activation gate) stays the same, so a `wide` model and a
 * `fast` model are interchangeable at a seam: the registry activates whichever
 * one scored better on the same held-out split.
 *
 * `auto` means "the host decides" and resolves to the device profile in
 * `device.js` — `android` on Termux, `server` elsewhere.
 */
export const MODEL_PRESETS = {
  auto: {
    id: 'auto',
    label: 'Auto',
    description: 'Let the host decide: phone-sized on Termux, two-layer nets on a server.'
  },
  fast: {
    id: 'fast',
    label: 'Fast',
    description: 'One small hidden layer. Trains in seconds and is the best fit for a busy node.',
    shapes: [[12], [16, 12], [20, 14]],
    epochs: 60,
    fastEpochs: 40,
    candidates: 2,
    maxPairs: 4000
  },
  balanced: {
    id: 'balanced',
    label: 'Balanced',
    description: 'Two hidden layers, the default server architecture. The accuracy/size sweet spot.',
    shapes: [[24, 16], [28, 18], [24, 20]],
    epochs: 120,
    fastEpochs: 60,
    candidates: 2,
    maxPairs: 12_000
  },
  wide: {
    id: 'wide',
    label: 'Wide',
    description: 'One wide hidden layer. Learns broad taste quickly and stays cheap to run per seam.',
    shapes: [[48, 24], [64, 32], [48, 32]],
    epochs: 140,
    fastEpochs: 70,
    candidates: 2,
    maxPairs: 15_000
  },
  deep: {
    id: 'deep',
    label: 'Deep',
    description: 'Two to four hidden layers. Slower to train, for a node with plenty of seams and CPU.',
    shapes: [[32, 24, 16], [40, 28, 16], [32, 24, 24, 12]],
    epochs: 180,
    fastEpochs: 90,
    candidates: 2,
    maxPairs: 20_000
  }
}

export const MODEL_PRESET_IDS = Object.freeze(Object.keys(MODEL_PRESETS))

export const isModelPreset = (id) => typeof id === 'string' && Object.hasOwn(MODEL_PRESETS, id)

/** The JSON surface the owner API and console render. */
export function modelPresets() {
  return MODEL_PRESET_IDS.map((id) => {
    const preset = MODEL_PRESETS[id]
    return {
      id,
      label: preset.label,
      description: preset.description,
      shapes: preset.shapes ?? null,
      epochs: preset.epochs ?? null,
      fastEpochs: preset.fastEpochs ?? null,
      candidates: preset.candidates ?? null,
      maxPairs: preset.maxPairs ?? null
    }
  })
}
