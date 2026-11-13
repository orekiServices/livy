#!/usr/bin/env python3
"""Train the DJ policy with PyTorch and hand the weights back to Node.

The server's own trainer (``src/core/models/network.js``) is a small, exact
implementation of the same network — one hidden stack, leaky ReLU, a linear
output, mean squared error, Adam. This script is the same network in PyTorch,
which is worth having for three reasons:

  * **Speed.** The JS loop visits the weights once per row. PyTorch does the
    same arithmetic in a handful of BLAS calls, so a training run over a few
    thousand seams is milliseconds and a *sweep* of candidate shapes is not
    a background job any more. The weights are identical in meaning, so the
    held-out accuracy the server reports is the one this model has.
  * **Hardware.** ``--device auto`` picks CUDA, then MPS, then the CPU. A node
    with a GPU can train a wider model than the JS path would attempt.
  * **A place to grow.** The next model (stem-aware, waveform, a sequence
    model over a whole set) will not be a 500-parameter MLP, and it will not
    be written twice.

What it deliberately does *not* do is serve. The file this writes is the same
``.bin`` the JS trainer writes, and inference stays in the server: no Python at
request time, no second runtime to keep alive, and a node with no Python at all
still mixes music.

Protocol — one JSON document in, one JSON document out::

    $ python train.py --probe
    {"ok": true, "torch": "2.5.1", "device": "cpu", "threads": 2, ...}

    $ python train.py < request.json
    {"ok": true, "results": [{"weights": [[...]], "biases": [[...]],
                              "loss": 0.0123, "ms": 41, "steps": 480, ...}]}

Request::

    {"x": [[...]], "y": [[...]],           # features, one-hot preferences
     "epochs": 120, "learningRate": 0.01, "batch": 16, "l2": 1e-4,
     "device": "auto", "threads": 0,
     "jobs": [{"shape": [24, 16], "seed": 24301}]}

Every failure is reported as ``{"ok": false, "reason": "..."}`` on stdout with
exit code 1, so the caller can fall back to its own trainer instead of parsing
a traceback.
"""

from __future__ import annotations

import json
import os
import sys
import time

# The activation the .bin format uses. One constant, so a model trained here
# and a model trained by the JS trainer are the same function.
LEAK = 0.01


def fail(reason: str, **extra) -> "None":
    json.dump({"ok": False, "reason": reason, **extra}, sys.stdout)
    sys.stdout.write("\n")
    sys.exit(1)


def capability() -> dict:
    """What this interpreter can do, without training anything."""
    import platform
    import time

    started = time.time()
    try:
        import torch
    except Exception as error:  # a wheel that will not import is "no torch"
        return {"ok": False, "reason": f"torch does not import ({error})", "python": sys.version.split()[0]}

    device = "cpu"
    try:
        if torch.cuda.is_available():
            device = "cuda"
        elif getattr(torch.backends, "mps", None) is not None and torch.backends.mps.is_available():
            device = "mps"
    except Exception:
        device = "cpu"

    return {
        "ok": True,
        "torch": torch.__version__,
        "python": sys.version.split()[0],
        "platform": platform.platform(),
        "device": device,
        "threads": torch.get_num_threads(),
        "cuda": bool(torch.cuda.is_available()),
        "ms": round((time.time() - started) * 1000, 1),
    }


def probe() -> None:
    answer = capability()
    json.dump(answer, sys.stdout)
    sys.stdout.write("\n")
    if not answer.get("ok"):
        sys.exit(1)


def build(torch, input_width: int, shape, output_width: int, seed: int, device: str):
    """The network's parameters, initialised the way the JS trainer does.

    He initialisation (variance 2/fan-in) on the weights and zeros for the
    biases, from a seeded generator: a run started here and a run started
    there begin from the same distribution, which is what makes the two
    backends comparable rather than merely similar.
    """
    widths = [input_width, *shape, output_width]
    generator = torch.Generator().manual_seed(int(seed))
    weights, biases = [], []
    for index in range(len(widths) - 1):
        fan_in, fan_out = widths[index], widths[index + 1]
        scale = (2.0 / fan_in) ** 0.5
        weights.append((torch.randn(fan_out, fan_in, generator=generator) * scale).to(device))
        biases.append(torch.zeros(fan_out, device=device))
    return weights, biases


def forward(torch, weights, biases, rows):
    """Activations per layer; the last one is linear, as the format requires."""
    activations = [rows]
    current = rows
    for index, weight in enumerate(weights):
        current = current @ weight.t() + biases[index]
        if index < len(weights) - 1:
            current = torch.where(current > 0, current, current * LEAK)
        activations.append(current)
    return activations


def fit(torch, x, y, shape, seed, epochs: int, learning_rate: float, batch: int, l2: float, max_steps: int, device: str):
    """Train one candidate.

    Backpropagation is written out rather than taken from autograd. That looks
    like re-inventing a wheel, and for a model of a thousand parameters it is
    the opposite: autograd spends ~40 small kernel launches per step recording
    a graph for two matrix multiplies, and the graph costs more than the
    arithmetic by an order of magnitude. The explicit version below is the
    same mathematics — mean squared error, leaky ReLU, Adam with the same
    betas and the same L2 term the JavaScript trainer uses — in eight matrix
    operations, which is where the speed comes from.
    """
    weights, biases = build(torch, x.shape[1], shape, y.shape[1], seed, device)
    moment_w = [torch.zeros_like(weight) for weight in weights]
    velocity_w = [torch.zeros_like(weight) for weight in weights]
    moment_b = [torch.zeros_like(bias) for bias in biases]
    velocity_b = [torch.zeros_like(bias) for bias in biases]
    generator = torch.Generator().manual_seed(int(seed) ^ 0x9E3779B9)
    beta1, beta2, epsilon = 0.9, 0.999, 1e-8
    steps = 0
    loss = 0.0
    rows = x.shape[0]
    batch = max(1, min(batch, rows))
    started = time.time()

    with torch.no_grad():
        for _epoch in range(epochs):
            if steps >= max_steps:
                break
            order = torch.randperm(rows, generator=generator)
            if device != "cpu":
                order = order.to(device)
            for start in range(0, rows, batch):
                if steps >= max_steps:
                    break
                index = order[start : start + batch]
                if index.numel() == 0:
                    continue
                xb, yb = x[index], y[index]
                activations = forward(torch, weights, biases, xb)
                output = activations[-1]
                # d(mse)/d(output) for the mean over the batch.
                delta = 2.0 * (output - yb) / output.shape[0]
                loss = float(((output - yb) ** 2).mean())
                grad_w = [None] * len(weights)
                grad_b = [None] * len(weights)
                for layer in range(len(weights) - 1, -1, -1):
                    grad_w[layer] = delta.t() @ activations[layer]
                    grad_b[layer] = delta.sum(0)
                    if layer > 0:
                        delta = delta @ weights[layer]
                        previous = activations[layer]
                        delta = delta * torch.where(previous > 0, torch.ones_like(previous), torch.full_like(previous, LEAK))
                steps += 1
                correction1 = 1 - beta1**steps
                correction2 = 1 - beta2**steps
                for layer in range(len(weights)):
                    gradient_w = grad_w[layer] + l2 * weights[layer]
                    moment_w[layer] = beta1 * moment_w[layer] + (1 - beta1) * gradient_w
                    velocity_w[layer] = beta2 * velocity_w[layer] + (1 - beta2) * gradient_w * gradient_w
                    weights[layer] -= learning_rate * (moment_w[layer] / correction1) / (torch.sqrt(velocity_w[layer] / correction2) + epsilon)
                    moment_b[layer] = beta1 * moment_b[layer] + (1 - beta1) * grad_b[layer]
                    velocity_b[layer] = beta2 * velocity_b[layer] + (1 - beta2) * grad_b[layer] * grad_b[layer]
                    biases[layer] -= learning_rate * (moment_b[layer] / correction1) / (torch.sqrt(velocity_b[layer] / correction2) + epsilon)
    return weights, biases, steps, loss, (time.time() - started) * 1000


def to_export(torch, weights, biases):
    """Weights in the `.bin` order: ``weights[layer][i * out + j]``."""
    return (
        [weight.detach().t().contiguous().reshape(-1).tolist() for weight in weights],
        [bias.detach().contiguous().tolist() for bias in biases],
    )


def capability() -> dict:
    """What this interpreter can do, without training anything."""
    import platform
    import time

    started = time.time()
    try:
        import torch
    except Exception as error:  # a wheel that will not import is "no torch"
        return {"ok": False, "reason": f"torch does not import ({error})", "python": sys.version.split()[0]}

    device = "cpu"
    try:
        if torch.cuda.is_available():
            device = "cuda"
        elif getattr(torch.backends, "mps", None) is not None and torch.backends.mps.is_available():
            device = "mps"
    except Exception:
        device = "cpu"

    return {
        "ok": True,
        "torch": torch.__version__,
        "python": sys.version.split()[0],
        "platform": platform.platform(),
        "device": device,
        "threads": torch.get_num_threads(),
        "cuda": bool(torch.cuda.is_available()),
        "ms": round((time.time() - started) * 1000, 1),
    }


def probe() -> None:
    answer = capability()
    json.dump(answer, sys.stdout)
    sys.stdout.write("\n")
    if not answer.get("ok"):
        sys.exit(1)


def train(request: dict, emit: bool = True) -> dict:
    """Train every requested candidate and return their weights.

    `emit` is False in worker mode, where the caller frames the answer; the
    one-shot CLI writes it straight to stdout.
    """
    import time

    def stop(reason, **extra):
        if emit:
            fail(reason, **extra)
        return {"ok": False, "reason": reason, **extra}

    started = time.time()
    try:
        import torch
    except Exception as error:
        return stop(f"torch does not import ({error})")

    try:
        x = torch.tensor(request["x"], dtype=torch.float32)
        y = torch.tensor(request["y"], dtype=torch.float32)
    except Exception as error:
        return stop(f"bad dataset ({error})")
    if x.ndim != 2 or y.ndim != 2:
        return stop("x and y must be matrices")
    if x.shape[0] != y.shape[0]:
        return stop(f"{x.shape[0]} feature rows but {y.shape[0]} label rows")
    if x.shape[0] == 0:
        return stop("empty dataset")

    epochs = max(1, int(request.get("epochs") or 120))
    learning_rate = float(request.get("learningRate") or 0.01)
    batch_size = max(1, min(int(request.get("batch") or 16), x.shape[0]))
    # A ceiling on the number of optimiser steps keeps a long run on a big log
    # from taking minutes: past a few thousand steps this network has already
    # found everything it is going to find.
    max_steps = max(1, int(request.get("maxSteps") or 6000))
    l2 = float(request.get("l2") or 1e-4)
    wanted = str(request.get("device") or "auto")
    threads = int(request.get("threads") or 0)
    if threads <= 0:
        # Half the cores is the useful default for these matrix sizes: the
        # server is also decoding audio, and oversubscribing it is slower than
        # training on one thread.
        threads = max(1, (os.cpu_count() or 2) // 2)
    torch.set_num_threads(threads)

    device = "cpu"
    if wanted == "auto":
        if torch.cuda.is_available():
            device = "cuda"
        elif getattr(torch.backends, "mps", None) is not None and torch.backends.mps.is_available():
            device = "mps"
    elif wanted in ("cpu", "cuda", "mps"):
        device = wanted
    try:
        x = x.to(device)
        y = y.to(device)
    except Exception:
        device = "cpu"
        x, y = x.to(device), y.to(device)

    jobs = request.get("jobs") or [{"shape": request.get("shape") or [24, 16], "seed": request.get("seed") or 0x5EED}]
    results = []
    for job in jobs:
        shape = [int(width) for width in (job.get("shape") or [24, 16])]
        seed = int(job.get("seed") or 0x5EED)
        weights, biases, steps, loss, ms = fit(
            torch,
            x,
            y,
            shape,
            seed,
            epochs=epochs,
            learning_rate=learning_rate,
            batch=batch_size,
            l2=l2,
            max_steps=max_steps,
            device=device,
        )
        export_w, export_b = to_export(torch, weights, biases)
        results.append(
            {
                "shape": [int(x.shape[1]), *shape, int(y.shape[1])],
                "hidden": shape,
                "seed": seed,
                "weights": [[round(value, 7) for value in layer] for layer in export_w],
                "biases": [[round(value, 7) for value in layer] for layer in export_b],
                "loss": round(loss, 6),
                "steps": steps,
                "epochs": epochs,
                "ms": round(ms, 1),
            }
        )

    answer = {
        "ok": True,
        "results": results,
        "rows": int(x.shape[0]),
        "batch": batch_size,
        "device": device,
        "threads": threads,
        "torch": torch.__version__,
        "ms": round((time.time() - started) * 1000, 1),
    }
    if emit:
        json.dump(answer, sys.stdout)
        sys.stdout.write("\n")
        return None
    return answer


def serve() -> None:
    """One JSON request per line in, one JSON answer per line out.

    This is how the server uses PyTorch: the first call pays for importing
    torch, every later one is a matrix multiply. Spawning a fresh interpreter
    per training run cost ~1.5 s of import on a quiet machine, which is more
    than the training it was asked for.
    """
    for line in sys.stdin:
        line = line.strip()
        if not line:
            continue
        identifier = None
        try:
            request = json.loads(line)
            identifier = request.get("id")
            kind = request.get("kind") or "train"
            if kind == "probe":
                answer = capability()
            elif kind == "exit":
                json.dump({"id": identifier, "ok": True}, sys.stdout)
                sys.stdout.write("\n")
                sys.stdout.flush()
                return
            else:
                answer = train(request, emit=False)
        except SystemExit:
            raise
        except Exception as error:  # never leave the caller reading a traceback
            answer = {"ok": False, "reason": f"{type(error).__name__}: {error}"}
        if identifier is not None:
            answer["id"] = identifier
        sys.stdout.write(json.dumps(answer))
        sys.stdout.write("\n")
        sys.stdout.flush()


def main() -> None:
    if "--serve" in sys.argv[1:]:
        return serve()
    if "--probe" in sys.argv[1:]:
        return probe()
    raw = sys.stdin.read()
    if not raw.strip():
        fail("no request on stdin")
    try:
        request = json.loads(raw)
    except Exception as error:
        fail(f"request is not JSON ({error})")
    return train(request)


if __name__ == "__main__":
    main()
