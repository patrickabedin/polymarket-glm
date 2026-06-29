#!/usr/bin/env python3
"""Generate performance report from pnl_log.jsonl"""
import json
import sys
from collections import defaultdict
from datetime import datetime

LOG_FILE = "data/pnl_log.jsonl"

with open(LOG_FILE) as f:
    lines = [json.loads(l) for l in f if l.strip()]

entries = {}
exits = []

for l in lines:
    if l.get("side") == "BUY":
        entries[l.get("tradeId")] = l
    elif l.get("type") == "EXIT":
        exits.append(l)

# Build closed trades with full detail
closed = []
for e in exits:
    entry = entries.get(e.get("tradeId"), {})
    pnl = e.get("pnlUsd", 0) or 0
    closed.append({
        "market": entry.get("market", e.get("market", "")),
        "entryPrice": entry.get("entryPrice", 0),
        "exitPrice": e.get("exitPrice", 0),
        "size": entry.get("size", 0),
        "pnl": pnl,
        "reason": e.get("exitReason", "unknown"),
        "holdMin": e.get("holdTimeMin", 0),
        "whale": entry.get("whale", ""),
        "signal": entry.get("signalType", ""),
        "entryTime": entry.get("timestamp", ""),
        "exitTime": e.get("exitTimestamp", ""),
    })

# Summary
wins = [t for t in closed if t["pnl"] > 0.01]
losses = [t for t in closed if t["pnl"] < -0.01]
breakeven = [t for t in closed if abs(t["pnl"]) <= 0.01]
total_pnl = sum(t["pnl"] for t in closed)

print("=" * 60)
print("POLYMARKET WHALE COPIER — PERFORMANCE REPORT")
print("=" * 60)
print(f"Generated: {datetime.utcnow().isoformat()}Z")
print(f"Period: All time")
print()

print("SUMMARY")
print(f"  Total trades entered: {len(entries)}")
print(f"  Total trades closed:  {len(closed)}")
print(f"  Still open:           {len(entries) - len(closed)}")
print(f"  Wins:                 {len(wins)}")
print(f"  Losses:               {len(losses)}")
print(f"  Breakeven:            {len(breakeven)}")
if closed:
    wr = len(wins) / len(closed) * 100
    print(f"  Win rate:             {wr:.1f}%")
print(f"  Total PnL:            ${total_pnl:+.2f}")
print()

# By exit reason
print("BY EXIT REASON")
by_reason = defaultdict(lambda: {"count": 0, "pnl": 0, "wins": 0})
for t in closed:
    r = t["reason"]
    by_reason[r]["count"] += 1
    by_reason[r]["pnl"] += t["pnl"]
    if t["pnl"] > 0.01:
        by_reason[r]["wins"] += 1

for reason, stats in sorted(by_reason.items(), key=lambda x: x[1]["count"], reverse=True):
    wr = stats["wins"] / stats["count"] * 100 if stats["count"] > 0 else 0
    print(f"  {reason[:55]:<55} n={stats['count']:>2}  pnl=${stats['pnl']:>+6.2f}  wr={wr:.0f}%")
print()

# By signal type
print("BY SIGNAL TYPE")
by_signal = defaultdict(lambda: {"count": 0, "pnl": 0, "wins": 0})
for t in closed:
    s = t["signal"]
    by_signal[s]["count"] += 1
    by_signal[s]["pnl"] += t["pnl"]
    if t["pnl"] > 0.01:
        by_signal[s]["wins"] += 1

for sig, stats in sorted(by_signal.items(), key=lambda x: x[1]["count"], reverse=True):
    wr = stats["wins"] / stats["count"] * 100 if stats["count"] > 0 else 0
    print(f"  {sig:<25} n={stats['count']:>2}  pnl=${stats['pnl']:>+6.2f}  wr={wr:.0f}%")
print()

# By whale
print("BY WHALE")
by_whale = defaultdict(lambda: {"count": 0, "pnl": 0, "wins": 0})
for t in closed:
    w = t["whale"]
    by_whale[w]["count"] += 1
    by_whale[w]["pnl"] += t["pnl"]
    if t["pnl"] > 0.01:
        by_whale[w]["wins"] += 1

for whale, stats in sorted(by_whale.items(), key=lambda x: x[1]["count"], reverse=True):
    wr = stats["wins"] / stats["count"] * 100 if stats["count"] > 0 else 0
    print(f"  {whale:<25} n={stats['count']:>2}  pnl=${stats['pnl']:>+6.2f}  wr={wr:.0f}%")
print()

# Trade details
print("TRADE DETAILS")
print(f"{'Market':<45} {'Entry':>6} {'Exit':>6} {'PnL':>7} {'Hold':>5} {'Reason':<30}")
print("-" * 105)
for t in closed:
    market = t["market"][:45]
    print(f"{market:<45} {t['entryPrice']:>6.3f} {t['exitPrice']:>6.3f} {t['pnl']:>+7.2f} {t['holdMin']:>4}m {t['reason'][:30]:<30}")

# Hold-to-resolution simulation
print()
print("HOLD-TO-RESOLUTION SIMULATION")
print("(Would we have done better holding until market resolved?)")
for t in closed:
    # If exit price > 0.5, market likely resolved YES ($1.00)
    # If exit price < 0.5, market likely resolved NO ($0.00)
    # This is a rough heuristic
    if t["exitPrice"] >= 0.5:
        resolution_value = 1.00
        outcome = "YES"
    else:
        resolution_value = 0.00
        outcome = "NO"
    hold_pnl = (resolution_value - t["entryPrice"]) * t["size"]
    diff = hold_pnl - t["pnl"]
    better = "BETTER" if diff > 0 else "WORSE"
    print(f"  {t['market'][:40]:<40} entry={t['entryPrice']:.3f} exit={t['exitPrice']:.3f} | hold={outcome}=${hold_pnl:+.2f} vs actual=${t['pnl']:+.2f} → {better} by ${diff:+.2f}")
