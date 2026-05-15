# SID Academy Projects — Coursework Tracking

**Separate from strategy bot work.** This file tracks assignments the user
has to complete as part of the SID Academy course. The instructor sets
tasks at the end of certain video lessons; transcripts of those lessons
have **"Project"** in the filename.

When the user says "**SID Academy Project**" they are referring to one
of these tasks — NOT the trading strategy bot.

---

## How to identify Project transcripts

Look in `C:\Claude Standalone\resources\Video Transcripts\SID Strategy\transcripts\`
for files matching `*Project*.txt` or `*Project*.srt`.

These should NOT be treated as strategy-rules-source-material. They are
homework tasks for the user to complete.

---

## Workflow when user mentions a Project (UPDATED 2026-05-15)

**The user is NOT asking for help — they want me to attempt the project
INDEPENDENTLY and then compare results with their own answers.** This is
a quality cross-check: two independent minds working from the same
transcript should reach the same conclusions about the strategy. If we
diverge, the discussion of WHY is the educational value.

So the steps are:

1. **Read the corresponding transcript** (filename will contain "Project").
2. **Identify the task** the instructor sets — usually involves chart
   plotting / analysis (entry/exit annotations, stop placement,
   risk/reward marking, etc.).
3. **Do the project independently** using:
   - TradingView MCP for chart work (set symbol, scroll to date, draw
     entry/stop/exit markers, screenshot)
   - My own analysis to identify setups from the transcript's rules
   - Whatever else the project requires
4. **Document my answers** in `SID/academy-projects/<project-name>/`:
   - `my-analysis.md` — written conclusions
   - `chart-X.png` — annotated chart screenshots
   - One file per ticker / setup if multiple
5. **Tell user when ready** — they then share THEIR answers and we
   compare.
6. **Discuss discrepancies** — any divergence in our conclusions is the
   most valuable part of the exercise.

### Critical: I do NOT see the user's answers first

To preserve the integrity of the cross-check, I must produce my analysis
**before** the user shows me theirs. If the user shares answers up front
I lose the independent-perspective value. Politely defer if asked to
"check my work" before I've done my own.

---

## Project log

Track each project here once started:

| Transcript file | Title | Status | Deliverable location |
|---|---|---|---|
| _(populated as projects come up)_ | | | |

---

## Things still NOT to do

Even with the new "independent attempt" workflow:

- ❌ Don't take ACCOUNT actions on user's behalf ("go to your broker and..."
  is for the user to do; I just analyse charts and document conclusions)
- ❌ Don't share my analysis before the user has had a chance to attempt
  their own — they may want to compare blind
- ❌ Don't read the user's answers FIRST and then "verify" them — that
  defeats the cross-check
- ❌ Don't mix project outputs with strategy bot code

## Default invocation pattern

When the user says:

> "Do SID Academy Project [name]"
> "Have a go at SID Academy Project [name]"
> "Try the SID Academy Project on [topic]"

→ Read the transcript, do the analysis independently, save outputs in
`SID/academy-projects/<name>/`, tell user when ready for comparison.

When the user says:

> "I've finished SID Academy Project [name], can you check my work?"

→ Politely defer: "Before I check yours, would you like me to do my own
independent attempt first? That gives us a cleaner cross-check." Then
proceed per their preference.
