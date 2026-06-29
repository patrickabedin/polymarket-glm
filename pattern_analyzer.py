#!/usr/bin/env python3
"""
Pattern Analyzer — Find what increases win rate

Usage: python3 pattern_analyzer.py

Reads data/patterns.jsonl and analyzes:
1. Win rate by whale (which whales are worth copying)
2. Win rate by category (sports vs politics vs crypto)
3. Win rate by signal type (ELITE_SHARP vs CONSENSUS vs WHALE_ENTRY)
4. Win rate by entry price bucket
5. Win rate by time of day
6. Win rate by spread/slippage
7. Win rate by exit reason
8. Average peak gain before exit (are we cutting winners too early?)
9. Hold-to-resolution simulation
10. Skipped trades analysis (missed opportunities)
"""

import json
import sys
from collections import defaultdict
from datetime import datetime

LOG_FILE = "data/patterns.jsonl"

try:
    with open(LOG_FILE) as f:
        lines = [json.loads(l) for l in f if l.strip()]
except FileNotFoundError:
    print("No patterns.jsonl found yet. Start trading first.")
    sys.exit(0)

entries = {}
exits = []
skipped = []

for l in lines:
    if l.get("type") == "ENTRY":
        entries[l.get("tradeId")] = l
    elif l.get("type") == "EXIT":
        exits.append(l)
    elif l.get("type") == "SKIPPED":
        skipped.append(l)

# Join entries with exits
closed = []
for e in exits:
    entry = entries.get(e.get("tradeId"), {})
    closed.append({**entry, **e, "entry": entry, "exit": e})

open_trades = [v for k, v in entries.items() if not any(e.get("tradeId") == k for e in exits)]

print("=" * 70)
print("POLYMARKET PATTERN ANALYZER")
print("=" * 70)
print(f"Generated: {datetime.utcnow().isoformat()}Z")
print(f"Entries: {len(entries)} | Exits: {len(exits)} | Open: {len(open_trades)} | Skipped: {len(skipped)}")
print()

if not closed:
    print("No closed trades yet. Need exits to analyze patterns.")
    sys.exit(0)

wins = [t for t in closed if t.get("outcome") == "WIN"]
losses = [t for t in closed if t.get("outcome") == "LOSS"]
be = [t for t in closed if t.get("outcome") == "BREAKEVEN"]
total_pnl = sum(t.get("pnlUsd", 0) for t in closed)

print(f"Win rate: {len(wins)}/{len(closed)} = {len(wins)/len(closed)*100:.1f}%")
print(f"Total PnL: ${total_pnl:+.2f}")
print(f"Avg PnL/trade: ${total_pnl/len(closed):+.3f}")
print()

def analyze_by(field, label):
    groups = defaultdict(list)
    for t in closed:
        val = t.get(field, t.get("entry", {}).get(field, "unknown"))
        if isinstance(val, list):
            val = ",".join(val[:3])
        groups[val].append(t)
    
    print(f"BY {label.upper()}")
    for val, trades in sorted(groups.items(), key=lambda x: -len(x[1])):
        w = sum(1 for t in trades if t.get("outcome") == "WIN")
        n = len(trades)
        pnl = sum(t.get("pnlUsd", 0) for t in trades)
        wr = w/n*100 if n > 0 else 0
        avg_pnl = pnl/n if n > 0 else 0
        print(f"  {str(val)[:40]:<40} n={n:>3}  wr={wr:>5.1f}%  pnl=${pnl:>+7.2f}  avg=${avg_pnl:>+6.3f}")
    print()

analyze_by("whaleUsername", "Whale")
analyze_by("category", "Category")
analyze_by("signalType", "Signal Type")
analyze_by("exitReason", "Exit Reason")

# By entry price bucket
print("BY ENTRY PRICE BUCKET")
buckets = defaultdict(list)
for t in closed:
    ep = t.get("entryPrice", 0)
    if ep < 0.20: b = "<0.20"
    elif ep < 0.35: b = "0.20-0.35"
    elif ep < 0.50: b = "0.35-0.50"
    elif ep < 0.70: b = "0.50-0.70"
    else: b = "0.70+"
    buckets[b].append(t)
for b, trades in sorted(buckets.items()):
    w = sum(1 for t in trades if t.get("outcome") == "WIN")
    n = len(trades)
    pnl = sum(t.get("pnlUsd", 0) for t in trades)
    wr = w/n*100 if n > 0 else 0
    print(f"  {b:<20} n={n:>3}  wr={wr:>5.1f}%  pnl=${pnl:>+7.2f}")
print()

# By time of day
print("BY HOUR (UTC)")
hours = defaultdict(list)
for t in closed:
    h = t.get("entry", {}).get("hourOfDayUTC", -1)
    hours[h].append(t)
for h, trades in sorted(hours.items()):
    w = sum(1 for t in trades if t.get("outcome") == "WIN")
    n = len(trades)
    pnl = sum(t.get("pnlUsd", 0) for t in trades)
    wr = w/n*100 if n > 0 else 0
    print(f"  {h:>2}h  n={n:>3}  wr={wr:>5.1f}%  pnl=${pnl:>+7.2f}")
print()

# Price vs whale entry
print("BY PRICE VS WHALE ENTRY")
pvw = defaultdict(list)
for t in closed:
    diff = t.get("priceVsWhaleEntry", 0)
    if diff < -0.02: b = "below whale (<-2%)"
    elif diff < 0.02: b = "at whale (±2%)"
    elif diff < 0.10: b = "above whale (+2-10%)"
    else: b = "far above whale (>+10%)"
    pvw[b].append(t)
for b, trades in sorted(pvw.items()):
    w = sum(1 for t in trades if t.get("outcome") == "WIN")
    n = len(trades)
    pnl = sum(t.get("pnlUsd", 0) for t in trades)
    wr = w/n*100 if n > 0 else 0
    print(f"  {b:<30} n={n:>3}  wr={wr:>5.1f}%  pnl=${pnl:>+7.2f}")
print()

# Peak gain analysis (are we cutting winners too early?)
print("PEAK GAIN ANALYSIS (winners only)")
winner_peaks = [t.get("maxGainPct", 0) for t in closed if t.get("outcome") == "WIN"]
if winner_peaks:
    print(f"  Avg peak gain: {sum(winner_peaks)/len(winner_peaks)*100:.1f}%")
    print(f"  Max peak gain: {max(winner_peaks)*100:.1f}%")
    actual_gains = [t.get("pnlPct", 0) for t in closed if t.get("outcome") == "WIN"]
    if actual_gains:
        print(f"  Avg actual gain: {sum(actual_gains)/len(actual_gains):.1f}%")
        print(f"  Gain captured: {sum(actual_gains)/len(actual_gains) / (sum(winner_peaks)/len(winner_peaks)*100) * 100:.1f}%")
print()

# Skipped trades
if skipped:
    print("SKIPPED TRADES (missed opportunities)")
    skip_reasons = defaultdict(int)
    for s in skipped:
        skip_reasons[s.get("skipReason", "unknown")] += 1
    for reason, count in sorted(skip_reasons.items(), key=lambda x: -x[1]):
        print(f"  {reason[:50]:<50} n={count}")
    print()

print("=" * 70)
print("RECOMMENDATIONS")
print("=" * 70)
# Auto-recommendations based on data
best_whales = defaultdict(lambda: {"n": 0, "wr": 0, "pnl": 0})
for t in closed:
    w = t.get("whaleUsername", "unknown")
    best_whales[w]["n"] += 1
    if t.get("outcome") == "WIN":
        best_whales[w]["wr"] += 1
    best_whales[w]["pnl"] += t.get("pnlUsd", 0)

print("\nBest whales (by PnL):")
for w, stats in sorted(best_whales.items(), key=lambda x: -x[1]["pnl"])[:5]:
    wr = stats["wr"]/stats["n"]*100 if stats["n"] > 0 else 0
    print(f"  {w:<25} n={stats['n']:>3}  wr={wr:.0f}%  pnl=${stats['pnl']:>+7.2f}")

worst_whales = sorted(best_whales.items(), key=lambda x: x[1]["pnl"])[:3]
print("\nWorst whales (consider blocking):")
for w, stats in worst_whales:
    if stats["n"] >= 2:
        wr = stats["wr"]/stats["n"]*100 if stats["n"] > 0 else 0
        print(f"  {w:<25} n={stats['n']:>3}  wr={wr:.0f}%  pnl=${stats['pnl']:>+7.2f}")
