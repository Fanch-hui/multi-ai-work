#!/usr/bin/env python3
"""Check period capacity using explicit net available hours and all allocations."""
import json
import sys
from decimal import Decimal
from pathlib import Path

def analyze(data):
    people = data["people"]
    capacity = {p["id"]: Decimal(str(p["net_available_hours"])) for p in people}
    if len(capacity) != len(people) or any(h < 0 for h in capacity.values()):
        raise ValueError("人员必须唯一且净可用工时非负")
    used = {name: Decimal(0) for name in capacity}
    unassigned = []
    for task in data["allocations"]:
        owner = task["person_id"]
        hours = Decimal(str(task["hours"]))
        if hours < 0:
            raise ValueError("投入工时必须非负")
        if owner not in capacity:
            unassigned.append(task["task_id"])
        else:
            used[owner] += hours
    rows = [{"person_id": name, "capacity": float(capacity[name]), "assigned": float(used[name]),
             "remaining": float(capacity[name] - used[name]), "overloaded": used[name] > capacity[name]}
            for name in capacity]
    return {"period": data["period"], "people": rows, "unassigned_tasks": unassigned,
            "capacity_feasible": not unassigned and not any(row["overloaded"] for row in rows),
            "scope": "仅检验所列期间净容量和分配总数；技能、日期重叠、依赖与范围另行核对"}

if __name__ == "__main__":
    data = json.loads(Path(sys.argv[1]).read_text(encoding="utf-8"))
    print(json.dumps(analyze(data), ensure_ascii=False, indent=2))
