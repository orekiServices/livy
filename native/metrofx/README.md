# metrofx — MetroFX

The filter and dynamics kernels behind [Livy](../../README.md), written in Rust
and bound to Node with [napi-rs](https://napi.rs).

The station filter chain is JavaScript first: it runs in the console, in the
preview renderer, on Vercel, and in every test. MetroFX is the optional fast
path for the four filters that are per-sample maths rather than a scheduling
problem:

| Class | Used by | What it replaces |
| --- | --- | --- |
| `Biquad` | EQ, low-pass, high-pass | 15–30 biquads × 2 channels per block |
| `Compressor` | compressor | a `log10` and a `pow` per sample |
| `Reverb` | reverb | 8 combs + 4 all-passes × 2 channels |
| `Distortion` | distortion | four waveshapers at 4× oversampling |

The algorithms are deliberate ports of `server/src/core/filters/`: same
coefficients, same Freeverb delay lengths, same soft-knee curve, same
oversampling topology. The JavaScript stays the readable reference.

```js
const fx = require('metrofx')
fx.available                    // is a binary for this host loaded?
fx.describe()                   // 'MetroFX 0.1.0 · linux · x86_64 · rust stable'

const eq = new fx.Biquad()
eq.set_peaking(1000, 6, 44100, 1.41)
eq.process(left, right, left.length)

const comp = new fx.Compressor()
comp.set_params(0.5, 4, 0.01, 0.2, 1, 1.2, 44100)
comp.process(left, right)
```

## Optional, always

`server/src/util/fx.js` loads this addon when a binary exists and falls back to
the JavaScript filter classes when it does not. There is no postinstall compile
and no failure mode where a missing toolchain stops a node from booting. Set
`LIVY_DISABLE_FX=1` to force the JavaScript path.

## Build

```bash
npm install
npm run build          # napi build --platform --release
npm run build:local    # cargo build --release + host-named copy
```

`scripts/build-linux-universal.sh` cross-builds the five Linux targets from one
x86_64 machine with zig, pinned to glibc 2.17, and writes them next to
`index.js` — where the loader looks. The checked-in Linux prebuilds were built
with `napi build --platform --release --target <triple>`.
