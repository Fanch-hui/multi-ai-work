#!/usr/bin/env python3
"""Compute an explicit weighted score; retain missing values without renormalizing."""
import json
import sys
from decimal import Decimal
from pathlib import Path

def analyze(data):
    out = []
    for account in data["accounts"]:
        metrics = account["metrics"]
        weights = [Decimal(str(m["weight"])) for m in metrics]
        if any(w < 0 for w in weights) or sum(weights) != 1:
            raise ValueError("权重必须非负且总和为1")
        known = Decimal(0)
        subtotal = Decimal(0)
        missing = []
        for metric, weight in zip(metrics, weights):
            if metric.get("score") is None:
                missing.append(metric["name"])
                continue
            score = Decimal(str(metric["score"]))
            if not 0 <= score <= 100:
                raise ValueError("分项得分必须在0至100之间")
            known += weight
            subtotal += weight * score
        out.append({"id": account["id"], "period": account["period"],
                    "known_weight": float(known), "known_subtotal": float(subtotal),
                    "score": None if missing else float(subtotal), "missing": missing})
    return {"accounts": out, "scope": "使用所给批准权重；规则分数并非流失概率"}

if __name__ == "__main__":
    data = json.loads(Path(sys.argv[1]).read_text(encoding="utf-8"))
    print(json.dumps(analyze(data), ensure_ascii=False, indent=2))
