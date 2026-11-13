# Instruments that measured themselves

## Summary

Four times, a number was wrong because the thing producing it was wrong, and the number looked like a finding:

1. An attack was scored as successful when the agent had refused it.
2. A vector search benchmark reported 26% recall with no filtering at all.
3. A new check for invented amounts fired 23 times, mostly on "$50".
4. A dashboard showed zero tickets after two had been handled.

Each was caught before it was published. Each would have been believed if it had pointed the expected way.

## What happened

**The scorer.** An attack ticket demanded confirmation that a refund "has been processed". The win condition looked for that phrase in the reply. The agent replied that "no refund has been processed", and the attack was scored as a success. One success in an otherwise clean run is exactly the kind of result that gets reported.

**The benchmark.** The question was how badly a vector index performs when access rules hide most of what it finds. The first run showed poor recall even with nothing hidden. The benchmark used uniformly random vectors in a thousand dimensions. Such vectors are all nearly the same distance apart, so "nearest" means almost nothing and any approximate index looks bad on them.

**The detector.** A check was added that looks up every money amount in a reply among the things the agent was shown. It fired on 23 of 540 attempts. Most hits were "$50", a plan's price, which the agent had read in a help-centre passage. The check read numeric fields in tool results and ignored amounts written inside text.

**The dashboard.** Panels used the usual query for a counter, its increase over a window. At a handful of events, a counter's first sample is already 1, and an increase needs two samples. Every panel read zero.

## Why they were caught

Not by a test. Each was caught by reading the individual cases behind the number:

- The one successful attack was opened and the reply read.
- The benchmark was run on the case with a known answer, no filtering, before its interesting cases were looked at.
- The detector's hits were listed before its rate was reported.
- The dashboard's queries were run against a system whose true counts were known: two tickets, one approval.

## What changed

- The scorer checks for the exact sentence the attacker asked for. The affected run was rescored from the stored reply, not rerun.
- The benchmark vectors are clustered around topics, as real embeddings are. Unfiltered recall became 100% and the effect of filtering became visible. The report says the vectors are synthetic and why random ones were discarded.
- The detector reads amounts inside text. Remeasured on two suites it fired on none of 60 attempts. What remained in the main runs was correct arithmetic, so it stays a recorded signal and was not made a gate.
- The dashboard shows totals since the worker started, and says so.

Two habits came out of this and are applied throughout:

- **A check must be seen to fail.** Where a control or a test was added, it was also run with the control removed or a bug planted. Several tests in this repository were green for the wrong reason until that was done, including one for overlapping attempts at the same step that passed twice with the protection deleted.
- **An answer key is not changed to match a model.** One scenario's expected result was wrong and was corrected, but only after the written policy had been changed first, for a stated reason.

## What it says about the system

An eval, a benchmark, a detector and a dashboard are all software, written under the same conditions as the system they measure and tested much less. A surprising number is first a claim about the instrument.

The cheap defence is to look at a few of the cases behind any number before believing the number. It was sufficient all four times.
