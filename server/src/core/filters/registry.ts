/**
 * The filter registry.
 *
 * One table decides three things that otherwise drift apart: what a payload
 * key is called, what order the chain runs it in, and what the console is told
 * about it. NodeLink's `FiltersManager` keeps the same table as a frozen
 * `FILTER_CLASSES` map and sorts by `priority`; this is that, plus the schema
 * kept next to the implementation rather than in a separate 400-line literal
 * that no longer matches the code.
 *
 * Adding a filter is two steps: write `filters/<name>.js`, add one line here.
 * Nothing else in the server learns a new name.
 */
import { TimescaleFilter } from './timescale.ts'
import { EqualizerFilter } from './equalizer.ts'
import { KaraokeFilter } from './karaoke.ts'
import { ChannelMixFilter } from './channelMix.ts'
import { CompressorFilter } from './compressor.ts'
import { DistortionFilter } from './distortion.ts'
import { LowpassFilter } from './lowpass.ts'
import { HighpassFilter } from './highpass.ts'
import { RotationFilter } from './rotation.ts'
import { SpatialFilter } from './spatial.ts'
import { TremoloFilter } from './tremolo.ts'
import { VibratoFilter } from './vibrato.ts'
import { ChorusFilter } from './chorus.ts'
import { PhaserFilter } from './phaser.ts'
import { FlangerFilter } from './flanger.ts'
import { EchoFilter } from './echo.ts'
import { ReverbFilter } from './reverb.ts'
import { PhonographFilter } from './phonograph.ts'
import { TesseractFilter } from './tesseract.ts'

/**
 * Every filter, by payload key.
 *
 * `settings` is the key the filter reads (they differ only for
 * `equalizerStandalone`, which shares the equaliser's code but not its key).
 * `priority` is where it sits in the chain — lower first — and the gaps are
 * deliberate, so a new filter slots in without renumbering.
 */
export const FILTERS = Object.freeze({
  timescale: { Filter: TimescaleFilter, priority: 1, stream: true },
  equalizer: { Filter: EqualizerFilter, priority: 5 },
  equalizerStandalone: { Filter: EqualizerFilter, priority: 6, settings: 'equalizerStandalone', single: true },
  karaoke: { Filter: KaraokeFilter, priority: 10 },
  channelMix: { Filter: ChannelMixFilter, priority: 10 },
  distortion: { Filter: DistortionFilter, priority: 11 },
  compressor: { Filter: CompressorFilter, priority: 11 },
  lowpass: { Filter: LowpassFilter, priority: 10 },
  highpass: { Filter: HighpassFilter, priority: 10 },
  rotation: { Filter: RotationFilter, priority: 10 },
  spatial: { Filter: SpatialFilter, priority: 10 },
  tremolo: { Filter: TremoloFilter, priority: 10 },
  vibrato: { Filter: VibratoFilter, priority: 10 },
  chorus: { Filter: ChorusFilter, priority: 10 },
  phaser: { Filter: PhaserFilter, priority: 10 },
  flanger: { Filter: FlangerFilter, priority: 10 },
  echo: { Filter: EchoFilter, priority: 12 },
  reverb: { Filter: ReverbFilter, priority: 13 },
  phonograph: { Filter: PhonographFilter, priority: 14 },
  tesseract: { Filter: TesseractFilter, priority: 15 }
})

/** Payload keys, in the order the README documents them. */
export const FILTER_NAMES = Object.keys(FILTERS)

/** The same names, in chain order. */
export const FILTER_ORDER = FILTER_NAMES.slice().sort((a, b) => FILTERS[a].priority - FILTERS[b].priority)

/** One filter's schema, as the REST surface publishes it. */
export function schemaFor(name) {
  const entry = FILTERS[name]
  if (!entry) return {}
  return entry.single && entry.Filter.standaloneSchema ? entry.Filter.standaloneSchema : (entry.Filter.schema ?? {})
}

/** The whole surface: every filter's defaults and limits. */
export function allSchemas() {
  const out = {}
  for (const name of FILTER_NAMES) out[name] = schemaFor(name)
  return out
}

export default FILTERS
