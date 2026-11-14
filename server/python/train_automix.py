#!/usr/bin/env python3
"""Optional PyTorch GPU/CPU trainer for Livy's Multi-Stage Neural AutoMix models.

Implements the same architectures as ``server/src/core/models/architectures.ts``
(``mlp-micro``, ``tcn-compact``, ``gru-dj``, ``transformer-mini``) so heavier
corpora and larger parameter budgets (100K–5M parameters) can train on CUDA or
Apple MPS GPUs while exporting exact Float32 weight tensors back to the
TypeScript runtime (zero Python dependency at broadcast/inference time).
"""
from __future__ import annotations

import json
import math
import sys
import time
from typing import Any, Dict, List


def fail(reason: str) -> None:
    json.dump({"ok": False, "reason": reason}, sys.stdout)
    sys.stdout.write("\n")
    sys.stdout.flush()


try:
    import torch
    import torch.nn as nn
    import torch.nn.functional as F
except Exception as exc:  # pragma: no cover
    fail(f"PyTorch unavailable: {exc}")
    sys.exit(0)


def pick_device(asked: str = "auto") -> torch.device:
    if asked == "cuda" and torch.cuda.is_available():
        return torch.device("cuda")
    if asked == "mps" and getattr(torch.backends, "mps", None) and torch.backends.mps.is_available():
        return torch.device("mps")
    if asked == "auto":
        if torch.cuda.is_available():
            return torch.device("cuda")
        if getattr(torch.backends, "mps", None) and torch.backends.mps.is_available():
            return torch.device("mps")
    return torch.device("cpu")


class NeuralAutoMixTorch(nn.Module):
    """Exact mirror of server/src/core/models/architectures.ts for GPU training."""

    def __init__(self, cfg: Dict[str, Any]):
        super().__init__()
        self.cfg = cfg
        self.arch = cfg["architecture"]
        self.pair_dim = int(cfg["pairDim"])
        self.seq_dim = int(cfg["seqDim"])
        self.seq_len = int(cfg["seqLen"])
        self.D = int(cfg["hiddenDim"])
        self.num_layers = int(cfg["numLayers"])
        self.num_heads = max(1, int(cfg.get("numHeads", 4)))
        while self.D % self.num_heads != 0 and self.num_heads > 1:
            self.num_heads -= 1
        self.knots = int(cfg["knots"])
        self.num_strategies = int(cfg["numStrategies"])
        self.auto_dim = 2 + 14 * self.knots

        if self.arch == "mlp-micro":
            fusion_w = self.pair_dim + self.seq_dim * 2
            self.mlp_blocks = nn.ModuleList([nn.Linear(self.D, self.D) for _ in range(self.num_layers)])
        elif self.arch == "tcn-compact":
            self.tcn_a = nn.ModuleList()
            self.tcn_b = nn.ModuleList()
            for l in range(self.num_layers):
                in_c = self.seq_dim if l == 0 else self.D
                dil = 1 << l
                self.tcn_a.append(nn.Conv1d(in_c, self.D, kernel_size=3, padding=dil, dilation=dil))
                self.tcn_b.append(nn.Conv1d(in_c, self.D, kernel_size=3, padding=dil, dilation=dil))
            fusion_w = self.pair_dim + self.D * 4
        elif self.arch == "gru-dj":
            self.gru_a = nn.GRU(self.seq_dim, self.D, num_layers=self.num_layers, batch_first=True)
            self.gru_b = nn.GRU(self.seq_dim, self.D, num_layers=self.num_layers, batch_first=True)
            fusion_w = self.pair_dim + self.D * 4
        else:
            self.proj_a = nn.Linear(self.seq_dim, self.D)
            self.proj_b = nn.Linear(self.seq_dim, self.D)
            self.self_a = nn.ModuleList([nn.MultiheadAttention(self.D, self.num_heads, batch_first=True) for _ in range(self.num_layers)])
            self.self_b = nn.ModuleList([nn.MultiheadAttention(self.D, self.num_heads, batch_first=True) for _ in range(self.num_layers)])
            self.cross_ab = nn.ModuleList([nn.MultiheadAttention(self.D, self.num_heads, batch_first=True) for _ in range(self.num_layers)])
            self.ffn1 = nn.ModuleList([nn.Linear(self.D, self.D * 2) for _ in range(self.num_layers)])
            self.ffn2 = nn.ModuleList([nn.Linear(self.D * 2, self.D) for _ in range(self.num_layers)])
            self.norm1 = nn.ModuleList([nn.LayerNorm(self.D) for _ in range(self.num_layers)])
            self.norm2 = nn.ModuleList([nn.LayerNorm(self.D) for _ in range(self.num_layers)])
            fusion_w = self.pair_dim + self.D * 4

        self.fusion_in = nn.Linear(fusion_w, self.D)
        self.fusion_norm = nn.LayerNorm(self.D)

        s1_h = max(8, round(self.D * 0.75))
        self.stage1_h = nn.Linear(self.D, s1_h)
        self.stage1_out = nn.Linear(s1_h, 5)

        self.stage2_h = nn.Linear(self.D + 5, self.D)
        self.stage2_norm = nn.LayerNorm(self.D)
        self.stage2_strategy = nn.Linear(self.D, self.num_strategies)
        self.stage2_automation = nn.Linear(self.D, self.auto_dim)

    def forward(self, pair: torch.Tensor, seq_a: torch.Tensor, seq_b: torch.Tensor):
        if self.arch == "mlp-micro":
            fused_in = torch.cat([pair, seq_a.mean(dim=1), seq_b.mean(dim=1)], dim=-1)
        elif self.arch == "tcn-compact":
            xa = seq_a.transpose(1, 2)
            xb = seq_b.transpose(1, 2)
            for l in range(self.num_layers):
                na = F.gelu(self.tcn_a[l](xa))
                nb = F.gelu(self.tcn_b[l](xb))
                xa = xa + na if l > 0 else na
                xb = xb + nb if l > 0 else nb
            xa = xa.transpose(1, 2)
            xb = xb.transpose(1, 2)
            pa = torch.cat([xa.mean(dim=1), xa.max(dim=1).values], dim=-1)
            pb = torch.cat([xb.mean(dim=1), xb.max(dim=1).values], dim=-1)
            fused_in = torch.cat([pair, pa, pb], dim=-1)
        elif self.arch == "gru-dj":
            xa, _ = self.gru_a(seq_a)
            xb, _ = self.gru_b(seq_b)
            pa = torch.cat([xa.mean(dim=1), xa.max(dim=1).values], dim=-1)
            pb = torch.cat([xb.mean(dim=1), xb.max(dim=1).values], dim=-1)
            fused_in = torch.cat([pair, pa, pb], dim=-1)
        else:
            xa = self.proj_a(seq_a)
            xb = self.proj_b(seq_b)
            for l in range(self.num_layers):
                sa, _ = self.self_a[l](xa, xa, xa, need_weights=False)
                sb, _ = self.self_b[l](xb, xb, xb, need_weights=False)
                xa = xa + sa
                xb = xb + sb
                ca, _ = self.cross_ab[l](xa, xb, xb, need_weights=False)
                xa = self.norm1[l](xa + ca)
                xa = self.norm2[l](xa + self.ffn2[l](F.gelu(self.ffn1[l](xa))))
            pa = torch.cat([xa.mean(dim=1), xa.max(dim=1).values], dim=-1)
            pb = torch.cat([xb.mean(dim=1), xb.max(dim=1).values], dim=-1)
            fused_in = torch.cat([pair, pa, pb], dim=-1)

        h = F.gelu(self.fusion_norm(self.fusion_in(fused_in)))
        if self.arch == "mlp-micro":
            for blk in self.mlp_blocks:
                h = h + F.gelu(blk(h))

        s1 = torch.sigmoid(self.stage1_out(F.gelu(self.stage1_h(h))))
        s2_h = F.gelu(self.stage2_norm(self.stage2_h(torch.cat([h, s1], dim=-1))))
        strat_logits = self.stage2_strategy(s2_h)
        auto_pre = self.stage2_automation(s2_h)

        # Bound automation outputs identically to TypeScript runtime
        K = self.knots
        parts = [
            0.2 + 0.65 * torch.sigmoid(auto_pre[:, 0:1]),
            0.04 + 0.31 * torch.sigmoid(auto_pre[:, 1:2]),
        ]
        for ch in range(14):
            sl = auto_pre[:, 2 + ch * K : 2 + (ch + 1) * K]
            parts.append(torch.tanh(sl) if ch in (10, 11) else torch.sigmoid(sl))
        automation = torch.cat(parts, dim=-1)
        return s1, strat_logits, automation

    def export_ts_weights(self) -> Dict[str, Dict[str, Any]]:
        """Export weights matching TypeScript ParamTensor names for mlp-micro & tcn-compact."""
        out: Dict[str, Dict[str, Any]] = {}

        def put_linear(prefix: str, mod: nn.Linear) -> None:
            w = mod.weight.detach().cpu().t().contiguous()
            b = mod.bias.detach().cpu().contiguous()
            out[f"{prefix}.w"] = {"shape": list(w.shape), "data": w.flatten().tolist()}
            out[f"{prefix}.b"] = {"shape": list(b.shape), "data": b.flatten().tolist()}

        def put_ln(prefix: str, mod: nn.LayerNorm) -> None:
            g = mod.weight.detach().cpu().contiguous()
            b = mod.bias.detach().cpu().contiguous()
            out[f"{prefix}.gamma"] = {"shape": list(g.shape), "data": g.flatten().tolist()}
            out[f"{prefix}.beta"] = {"shape": list(b.shape), "data": b.flatten().tolist()}

        if self.arch == "mlp-micro":
            for i, blk in enumerate(self.mlp_blocks):
                put_linear(f"mlp.{i}", blk)
        elif self.arch == "tcn-compact":
            for i, conv in enumerate(self.tcn_a):
                # PyTorch Conv1d: [outCh, inCh, k] -> TS: [k, inCh, outCh]
                w = conv.weight.detach().cpu().permute(2, 1, 0).contiguous()
                b = conv.bias.detach().cpu().contiguous()
                out[f"tcnA.{i}.w"] = {"shape": list(w.shape), "data": w.flatten().tolist()}
                out[f"tcnA.{i}.b"] = {"shape": list(b.shape), "data": b.flatten().tolist()}
            for i, conv in enumerate(self.tcn_b):
                w = conv.weight.detach().cpu().permute(2, 1, 0).contiguous()
                b = conv.bias.detach().cpu().contiguous()
                out[f"tcnB.{i}.w"] = {"shape": list(w.shape), "data": w.flatten().tolist()}
                out[f"tcnB.{i}.b"] = {"shape": list(b.shape), "data": b.flatten().tolist()}
        else:
            # GRU & Transformer weights can be serialized via torch state_dict; return empty to signal TS fallback if incompatible.
            return {}

        put_linear("fusion.in", self.fusion_in)
        put_ln("fusion.norm", self.fusion_norm)
        put_linear("stage1.h", self.stage1_h)
        put_linear("stage1.out", self.stage1_out)
        put_linear("stage2.h", self.stage2_h)
        put_ln("stage2.norm", self.stage2_norm)
        put_linear("stage2.strategy", self.stage2_strategy)
        put_linear("stage2.automation", self.stage2_automation)
        return out


def main() -> None:
    raw = sys.stdin.read().strip()
    if not raw:
        fail("empty request")
        return
    req = json.loads(raw)
    cfg = req["config"]
    device = pick_device(req.get("device", "auto"))
    torch.manual_seed(int(cfg.get("seed", 42)))

    model = NeuralAutoMixTorch(cfg).to(device)
    if not model.export_ts_weights():
        fail(f"direct TS weight export not enabled for {cfg['architecture']}; use TypeScript trainer")
        return

    def pack_split(rows: List[Dict[str, Any]]):
        pair = torch.tensor([r["pair"] for r in rows], dtype=torch.float32, device=device)
        sa = torch.tensor([r["seqA"] for r in rows], dtype=torch.float32, device=device)
        sb = torch.tensor([r["seqB"] for r in rows], dtype=torch.float32, device=device)
        y_s1 = torch.tensor([r["target"]["stage1"] for r in rows], dtype=torch.float32, device=device)
        y_st = torch.tensor([int(r["target"]["strategyIndex"]) for r in rows], dtype=torch.long, device=device)
        y_au = torch.tensor([r["target"]["automation"] for r in rows], dtype=torch.float32, device=device)
        return pair, sa, sb, y_s1, y_st, y_au

    tr_pair, tr_sa, tr_sb, tr_s1, tr_st, tr_au = pack_split(req["train"])
    va_pair, va_sa, va_sb, va_s1, va_st, va_au = pack_split(req["val"])

    epochs = int(req.get("epochs", 40))
    batch_size = max(1, int(req.get("batchSize", 16)))
    lr = float(req.get("learningRate", 3e-3))
    wd = float(req.get("weightDecay", 1e-4))
    opt = torch.optim.AdamW(model.parameters(), lr=lr, weight_decay=wd)
    sched = torch.optim.lr_scheduler.CosineAnnealingLR(opt, T_max=max(1, epochs), eta_min=lr * 0.1)

    history = []
    best_val = math.inf
    best_state = None
    t0 = time.time()

    n = tr_pair.shape[0]
    for epoch in range(1, epochs + 1):
        model.train()
        perm = torch.randperm(n, device=device)
        tr_loss_acc = 0.0
        steps = 0
        for start in range(0, n, batch_size):
            idx = perm[start : start + batch_size]
            opt.zero_grad()
            s1, logits, auto = model(tr_pair[idx], tr_sa[idx], tr_sb[idx])
            loss = F.mse_loss(s1, tr_s1[idx]) + 0.5 * F.cross_entropy(logits, tr_st[idx]) + 1.5 * F.mse_loss(auto, tr_au[idx])
            loss.backward()
            torch.nn.utils.clip_grad_norm_(model.parameters(), 2.0)
            opt.step()
            tr_loss_acc += float(loss.item())
            steps += 1
        sched.step()

        model.eval()
        with torch.no_grad():
            vs1, vlogits, vauto = model(va_pair, va_sa, va_sb)
            vloss = float((F.mse_loss(vs1, va_s1) + 0.5 * F.cross_entropy(vlogits, va_st) + 1.5 * F.mse_loss(vauto, va_au)).item())
            vtop1 = float((vlogits.argmax(dim=-1) == va_st).float().mean().item())
            vrmse = float(torch.sqrt(F.mse_loss(vauto, va_au)).item())
        if vloss < best_val:
            best_val = vloss
            best_state = {k: v.detach().cpu().clone() for k, v in model.state_dict().items()}
        history.append(
            {
                "epoch": epoch,
                "learningRate": round(sched.get_last_lr()[0], 6),
                "trainLoss": round(tr_loss_acc / max(1, steps), 5),
                "valLoss": round(vloss, 5),
                "valStrategyTop1": round(vtop1, 4),
                "valAutomationRmse": round(vrmse, 4),
            }
        )

    if best_state is not None:
        model.load_state_dict(best_state)
    json.dump(
        {
            "ok": True,
            "device": str(device),
            "torch": torch.__version__,
            "ms": int((time.time() - t0) * 1000),
            "weights": model.export_ts_weights(),
            "history": history,
        },
        sys.stdout,
    )
    sys.stdout.write("\n")
    sys.stdout.flush()


if __name__ == "__main__":
    main()
