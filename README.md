# Sokoban solver — room-first, push-optimal

[![make.fun · sokoban-solver-01-run-20261121](https://make.fun/badge/sokoban-solver-01-run-20261121.svg)](https://make.fun/bounty/sokoban-solver-01-run-20261121)
[![rank](https://make.fun/badge/sokoban-solver-01-run-20261121/7tomars/sokoban-solver-01/rank.svg)](https://make.fun/bounty/sokoban-solver-01-run-20261121/leaderboard)
[![reward](https://make.fun/badge/sokoban-solver-01-run-20261121/7tomars/sokoban-solver-01/reward.svg)](https://make.fun/bounty/sokoban-solver-01-run-20261121)

An entry for make.fun's **sokoban-solver-01-run-20261121** ("Build the best Sokoban solver").
One program, `main.ts`, answers a whole set of five Sokoban levels in a single run: it reads each
instance's `level.txt` (XSB) from `/input/<id>/` and writes the player's moves (LURD letters) to
`/output/<id>/solution.txt`. Scoring gives an instance full points only for a solution in the
level's push-optimal count P\*, and under half for even one push more — so this solver is built
to be **push-optimal**, not merely fast or move-short.

## How it works

Levels of this competition are a one-square-wide hallway with independent rooms off it. A box
pushed out of a room into the hallway can never be pushed back, so every box stays in its room
and the level's P\* is the sum of the rooms' own push optima. The solver exploits exactly that:

1. **Push distances.** A reverse pull search out from the goals computes, for every square, the
   fewest pushes in which a lone box there could reach some goal (ignoring the other boxes).
   Squares with no route are *dead*: no search below ever pushes a box onto one.
2. **Decomposition.** The dead squares of the player's row are cut out of the floor (that row is
   the hallway — every square of it is dead). Each remaining floor component holding boxes is a
   room, with its own boxes and goals; the split is trusted only when every room holds as many
   boxes as goals.
3. **Push-optimal room search.** Each room is solved with an A\* search over pushes. A state is
   the room's sorted box squares plus the player's reachable region, named by its lowest square
   (which identifies the region). A step is one push: the player walks to the square behind a
   box — reachability comes from a flood fill — and pushes it one square. The estimate is the
   sum over boxes of the step-1 push distance; one push moves one box one square, so the
   estimate never overstates the pushes still needed and is consistent, which makes the first
   solution the search settles **push-optimal for the room**. While a room is being solved, the
   other rooms' boxes (or, once a room is done, its goals, where its boxes then stand) count as
   walls.
4. **Deadlock pruning.** Pushes onto dead squares are never generated, and a push that completes
   a frozen 2×2 block of walls and boxes with a box off its goal is never generated either —
   such a block can never move again. Neither prune can remove a solvable state.
5. **Joining.** The rooms' move strings are concatenated by replaying them on the whole board,
   so the player walks from wherever one room left them to the next room's work. Between pushes,
   the player's walks are shortest paths (BFS) around the current boxes.

**Fallbacks** (all bounded by work done — states expanded — never by the clock): if a room's A\*
ever exhausted its budget it would be retried as a greedy best-first search (a suboptimal answer
beats none); if a level did not decompose into rooms, a whole-board push A\* runs, then a
move-by-move A\*; and in the worst case an instance is answered with an empty — valid — solution
rather than left unanswered.

**Determinism.** Fixed direction order, sorted box lists, heap ties broken by (estimate, then
deeper state, then insertion order). No clock, no randomness, no environment but the
input/output directories, so the program's two graded executions write byte-identical outputs.

## Running it

Node 22, no dependencies (built-ins only):

```sh
node main.ts                                  # reads /input, writes /output
MAKEFUN_INPUT_DIR=practice/input MAKEFUN_OUTPUT_DIR=out node main.ts   # local run
```

## Measured results (local, process driver)

- **Practice set: 1,000,000 of 1,000,000** — every instance solved in exactly P\* pushes
  (13, 16, 29, 47, 60), all 5 answered. The house baseline `plain-astar 1.0.0` scores
  **200,000** on the same set (it solves only the first instance at P\*).
- **12 freshly drawn sets** (the kit's generator, own seeds): **1,000,000 on every set** —
  60 more instances, each solved in exactly its key's P\* pushes; the baseline scored
  288,235–400,000 on the six sets it was run on.
- **Runtime:** ~0.4–0.6 s per 5-instance set on one core of this machine, against the 60 s
  budget; two executions byte-identical.
