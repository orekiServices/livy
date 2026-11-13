# PyTorch training for the DJ policy (optional)

`train.py` trains the same network as `src/core/models/network.js` — same
initialisation, same leaky ReLU, same mean-squared loss, same Adam — in
PyTorch, and hands the weights back in the `.bin` layout the server loads. It
is an **optional accelerator**, never a requirement: a node without Python
trains in JavaScript, and inference is always the server's own.

## Install

```bash
cd server
python3 -m venv .venv
.venv/bin/pip install -r python/requirements.txt
```

The server finds `.venv/bin/python` (or `venv/`, `../.venv`, `PATH`) by
itself. A CPU-only wheel is enough and much smaller — from the PyTorch index:

```bash
.venv/bin/pip install torch --index-url https://download.pytorch.org/whl/cpu
```

On a platform where the PyPI wheel expects CUDA libraries, that CPU index is
the wheel you want.

## When it is used

`auto` (the default) asks the workload first:

| Host / workload | Backend |
|---|---|
| a GPU or Apple GPU is visible (`cuda`, `mps`) | PyTorch |
| 4,000+ labelled seams | PyTorch |
| a model wider than 5,000 parameters | PyTorch |
| anything smaller on a CPU | JavaScript |

That is not laziness. One Python optimiser step costs roughly half a
millisecond of kernel dispatch no matter how small the matrices are, so for a
few hundred seams the in-process JavaScript loop is genuinely quicker; PyTorch
starts to win as soon as the arithmetic outweighs the dispatch, and always wins
on a GPU. Both paths are measured on the same held-out split, and the report
says which one ran, where, and how long it took.

Force one or the other:

```bash
LIVY_TRAIN_BACKEND=torch bun test        # always PyTorch, fall back on failure
LIVY_TRAIN_BACKEND=js bun test           # never leave the process
```

or per request, from the console or the API:

```bash
curl -X POST localhost:2333/api/v1/owner/stations/main/dj-model/train \
  -H "x-owner-key: $LIVY_KEY" -H 'content-type: application/json' \
  -d '{"backend":"torch","count":3}'
```

`/api/v1/owner/models` reports what this node can do:

```json
{
  "torch": {
    "available": true,
    "interpreter": "/srv/livy/server/.venv/bin/python3",
    "torch": "2.5.1+cu124",
    "device": "cpu",
    "threads": 2
  },
  "backend": "auto"
}
```

## Protocol

The server keeps one worker alive (`python train.py --serve`, one JSON request
per line) so importing torch is paid once, not per run. The one-shot form is
the same code:

```bash
.venv/bin/python python/train.py --probe            # capability
.venv/bin/python python/train.py < request.json     # train
```

```json
{
  "x": [[0.1, -0.4, "…16 features"]],
  "y": [[1, 0, 0, "…10 preferences"]],
  "epochs": 120, "learningRate": 0.01, "batch": 64, "maxSteps": 1200,
  "device": "auto",
  "jobs": [{ "shape": [24, 16], "seed": 24301 }]
}
```

→

```json
{
  "ok": true,
  "results": [{ "shape": [16, 24, 16, 10], "weights": [[…]], "biases": [[…]],
                "loss": 0.0012, "steps": 1200, "ms": 612 }],
  "device": "cpu", "torch": "2.5.1+cu124", "threads": 2
}
```

Every failure is `{"ok": false, "reason": "..."}` with exit code 1, never a
traceback on stdout, so the caller can fall back to its own trainer.
