// Room-first push-optimal Sokoban solver.
//
// A level of this competition is a hallway with independent rooms off it: a box pushed out of a
// room into the hallway can never come back, so each room is its own small Sokoban problem and
// the level's push optimum is the sum of the rooms'. This solver works that way:
//
//   1. Parse the level (XSB) and compute, for every square, the fewest pushes in which a lone
//      box standing there could reach some goal (a reverse pull search out from the goals,
//      ignoring the other boxes). Squares with no such route are dead: a box pushed there can
//      never score, so no search below ever pushes one there.
//   2. Cut the dead squares out of the player's own row (that row is the hallway: every square
//      of it is dead) and take the floor components that remain. A component holding boxes is a
//      room, with its own boxes and goals; the components are checked to hold as many boxes as
//      goals before they are trusted.
//   3. Solve each room in turn with an A* search over pushes. A state is the room's sorted box
//      squares plus the player's reachable region (named by its lowest square, which identifies
//      the region). A step is one push: the player walks to the square behind a box (reachability
//      comes from a flood fill) and pushes it one square. The estimate is the sum over boxes of
//      the lone-box push distance of step 1, which never overstates the pushes still needed (one
//      push moves one box one square) and is consistent, so the first solution the search settles
//      is push-optimal for the room. Two deadlock prunes keep the search small: pushes onto dead
//      squares are never made, and a push that completes a frozen 2 x 2 block of walls and boxes
//      with a box off its goal is never made (such a block can never move again).
//   4. The rooms' move strings are joined by replaying them on the whole board, so the player
//      walks from wherever one room left them to the next room's work. While a room is solved,
//      the other rooms' boxes (or, once a room is done, its goals, where its boxes then stand)
//      count as walls: a room's boxes never leave it, so this changes nothing it can do.
//
// Fallbacks, all bounded by work done (states expanded), never by the clock, so two runs of the
// program write the same bytes: if a room's A* ever ran out of budget it is retried as a greedy
// best-first search (any solution beats none); if the level does not decompose into rooms, a
// whole-board push A* runs, then a move-by-move A*; and in the worst case an instance is
// answered with an empty (valid) solution rather than left unanswered.
//
// Everything is deterministic: fixed direction order, sorted boxes, heap ties broken by
// (estimate, then deeper state, then insertion order). No clock, no randomness, no environment
// but the input/output directories.
import { mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const INPUT_DIR = process.env.MAKEFUN_INPUT_DIR ?? '/input';
const OUTPUT_DIR = process.env.MAKEFUN_OUTPUT_DIR ?? '/output';

// Directions in a fixed order: up, down, left, right. [dx, dy, walk letter, push letter].
const DIRS = [
  [0, -1, 'u', 'U'],
  [0, 1, 'd', 'D'],
  [-1, 0, 'l', 'L'],
  [1, 0, 'r', 'R'],
];

// Work budgets, counted in expanded states. A generated room is small (3 or 4 boxes on at most
// 36 floor squares, optimum 12 to 20 pushes), so these caps are headroom, not expectations.
const ROOM_ASTAR_BUDGET = 900_000;
const ROOM_GREEDY_BUDGET = 900_000;
const BOARD_ASTAR_BUDGET = 1_500_000;
const MOVE_ASTAR_BUDGET = 1_500_000;

const INF = 1e9;

/** Parse XSB level text into {w, h, wall, goals, boxes (sorted), player}; the outer frame is wall. */
function parseLevel(text) {
  const rows = text.split('\n').filter((r) => r.length > 0);
  const h = rows.length;
  const w = Math.max(...rows.map((r) => r.length));
  const wall = new Uint8Array(w * h).fill(1);
  const goals = [];
  const boxes = [];
  let player = -1;
  rows.forEach((row, y) => {
    for (let x = 0; x < row.length; x++) {
      const ch = row[x];
      const i = y * w + x;
      if (ch === '#') continue;
      wall[i] = 0;
      if (ch === '.' || ch === '*' || ch === '+') goals.push(i);
      if (ch === '$' || ch === '*') boxes.push(i);
      if (ch === '@' || ch === '+') player = i;
    }
  });
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      if (x === 0 || y === 0 || x === w - 1 || y === h - 1) wall[y * w + x] = 1;
    }
  }
  boxes.sort((a, b) => a - b);
  goals.sort((a, b) => a - b);
  return { w, h, wall, goals, boxes, player };
}

/**
 * For every square, the fewest pushes in which a lone box there could reach some goal, by a
 * reverse (pull) search out from the goals over open floor: a box at y is pushed in direction d
 * onto x = y + d when the player can stand at y - d, so from a square x at distance n the search
 * steps back to y = x - d at distance n + 1 when both y and y - d are off the wall. Squares the
 * search never reaches get INF: dead squares.
 */
function pushDistances(w, wall, goals) {
  const dist = new Int32Array(wall.length).fill(INF);
  const queue = [];
  for (const g of goals) {
    dist[g] = 0;
    queue.push(g);
  }
  for (let qi = 0; qi < queue.length; qi++) {
    const x = queue[qi];
    for (let k = 0; k < 4; k++) {
      const d = DIRS[k][1] * w + DIRS[k][0];
      const y = x - d;
      if (wall[y] || wall[y - d] || dist[y] !== INF) continue;
      dist[y] = dist[x] + 1;
      queue.push(y);
    }
  }
  return dist;
}

/**
 * The level's rooms, or null when the level is not a clean set of rooms. The dead squares of the
 * player's row (the hallway) are cut out of the floor; each remaining component holding boxes is
 * a room. Null when a box starts on a cut square, a goal lies on one, or some component's boxes
 * and goals differ in number.
 */
function decompose(level) {
  const { w, wall, goals, boxes, player } = level;
  const dist = pushDistances(w, wall, goals);
  const cut = new Uint8Array(wall.length);
  const row = Math.floor(player / w);
  for (let i = row * w; i < (row + 1) * w; i++) {
    if (!wall[i] && dist[i] >= INF) cut[i] = 1;
  }
  if (boxes.some((b) => cut[b])) return null;
  const part = new Int32Array(wall.length).fill(-1);
  const rooms = [];
  const stack = [];
  for (let s = 0; s < wall.length; s++) {
    if (wall[s] || cut[s] || part[s] >= 0) continue;
    const id = rooms.length;
    const squares = [s];
    part[s] = id;
    stack.push(s);
    while (stack.length > 0) {
      const p = stack.pop();
      for (let k = 0; k < 4; k++) {
        const q = p + DIRS[k][1] * w + DIRS[k][0];
        if (!wall[q] && !cut[q] && part[q] < 0) {
          part[q] = id;
          squares.push(q);
          stack.push(q);
        }
      }
    }
    rooms.push({ squares, boxes: [], goals: [], done: false });
  }
  for (const b of boxes) rooms[part[b]].boxes.push(b);
  for (const g of goals) {
    if (part[g] < 0) return null;
    rooms[part[g]].goals.push(g);
  }
  if (rooms.some((r) => r.boxes.length !== r.goals.length)) return null;
  return rooms.filter((r) => r.boxes.length > 0);
}

/** Flood fill of the player's reachable region from `from`; marks seen[] with `stamp`, returns its lowest square. */
function floodRegion(w, wall, occupied, from, seen, stamp, stack) {
  let low = from;
  let n = 0;
  stack[n++] = from;
  seen[from] = stamp;
  while (n > 0) {
    const p = stack[--n];
    if (p < low) low = p;
    const up = p - w;
    const dn = p + w;
    const lf = p - 1;
    const rt = p + 1;
    if (!wall[up] && !occupied[up] && seen[up] !== stamp) { seen[up] = stamp; stack[n++] = up; }
    if (!wall[dn] && !occupied[dn] && seen[dn] !== stamp) { seen[dn] = stamp; stack[n++] = dn; }
    if (!wall[lf] && !occupied[lf] && seen[lf] !== stamp) { seen[lf] = stamp; stack[n++] = lf; }
    if (!wall[rt] && !occupied[rt] && seen[rt] !== stamp) { seen[rt] = stamp; stack[n++] = rt; }
  }
  return low;
}

/** Whether the box just pushed onto `t` completes a frozen 2 x 2 block with a box off its goal. */
function frozenBlock(w, wall, occupied, goalAt, t) {
  const corners = [t, t - 1, t - w, t - w - 1];
  for (let c = 0; c < 4; c++) {
    const a = corners[c];
    const b = a + 1;
    const cc = a + w;
    const d = cc + 1;
    if (!(wall[a] || occupied[a]) || !(wall[b] || occupied[b]) || !(wall[cc] || occupied[cc]) || !(wall[d] || occupied[d])) continue;
    if ((occupied[a] && !goalAt[a]) || (occupied[b] && !goalAt[b]) || (occupied[cc] && !goalAt[cc]) || (occupied[d] && !goalAt[d])) return true;
  }
  return false;
}

/** The shortest walk from `from` to `to` around walls and boxes, in lower-case letters ('' when already there). */
function walkPath(w, wall, occupied, from, to) {
  if (from === to) return '';
  const prev = new Int32Array(wall.length).fill(-1);
  const how = new Int8Array(wall.length).fill(-1);
  const queue = [from];
  prev[from] = from;
  for (let qi = 0; qi < queue.length; qi++) {
    const p = queue[qi];
    if (p === to) break;
    for (let k = 0; k < 4; k++) {
      const q = p + DIRS[k][1] * w + DIRS[k][0];
      if (wall[q] || occupied[q] || prev[q] !== -1) continue;
      prev[q] = p;
      how[q] = k;
      queue.push(q);
    }
  }
  if (prev[to] === -1) return null;
  let s = '';
  for (let p = to; p !== from; p = prev[p]) s = DIRS[how[p]][2] + s;
  return s;
}

/**
 * A push search over one board: {w, wall, goals, boxes, player}. mode 'astar' orders states by
 * pushes + estimate (push-optimal); mode 'greedy' orders by estimate alone (any solution).
 * Returns {pushes, moves} or null when the expansion budget runs out first.
 */
function searchPushes(board, mode, budget) {
  const { w, wall, goals, boxes: startBoxes, player } = board;
  const size = wall.length;
  const n = startBoxes.length;
  const goalAt = new Uint8Array(size);
  for (const g of goals) goalAt[g] = 1;
  const dist = pushDistances(w, wall, goals);
  for (const b of startBoxes) if (dist[b] >= INF) return null;
  const estimate = (bs) => {
    let s = 0;
    for (let i = 0; i < n; i++) s += dist[bs[i]];
    return s;
  };
  const numericKeys = Math.pow(size, n + 1) < 2 ** 53;
  const keyOf = (bs, rep) => {
    if (numericKeys) {
      let k = rep;
      for (let i = 0; i < n; i++) k = k * size + bs[i];
      return k;
    }
    return String.fromCharCode(rep, ...bs);
  };

  // States in flat arrays, grown as needed.
  let cap = 1024;
  let sBoxes = new Int32Array(cap * n);
  let sParent = new Int32Array(cap);
  let sG = new Int32Array(cap);
  let sRep = new Int32Array(cap);
  let sFrom = new Int32Array(cap);
  let sDir = new Int8Array(cap);
  let count = 0;
  const grow = () => {
    cap *= 2;
    const nb = new Int32Array(cap * n); nb.set(sBoxes); sBoxes = nb;
    const np = new Int32Array(cap); np.set(sParent); sParent = np;
    const ng = new Int32Array(cap); ng.set(sG); sG = ng;
    const nr = new Int32Array(cap); nr.set(sRep); sRep = nr;
    const nf = new Int32Array(cap); nf.set(sFrom); sFrom = nf;
    const nd = new Int8Array(cap); nd.set(sDir); sDir = nd;
  };
  const addState = (bs, parent, g, rep, from, dir) => {
    if (count >= cap) grow();
    sBoxes.set(bs, count * n);
    sParent[count] = parent;
    sG[count] = g;
    sRep[count] = rep;
    sFrom[count] = from;
    sDir[count] = dir;
    return count++;
  };

  // Binary heap of state indices ordered by (f, then deeper g, then insertion order).
  const heap = [];
  const heapF = [];
  const heapSeq = [];
  let seq = 0;
  const before = (a, b) => {
    const fa = heapF[a];
    const fb = heapF[b];
    if (fa !== fb) return fa < fb;
    const ga = sG[heap[a]];
    const gb = sG[heap[b]];
    if (ga !== gb) return ga > gb;
    return heapSeq[a] < heapSeq[b];
  };
  const heapPush = (state, f) => {
    heap.push(state);
    heapF.push(f);
    heapSeq.push(seq++);
    let i = heap.length - 1;
    while (i > 0) {
      const p = (i - 1) >> 1;
      if (!before(i, p)) break;
      [heap[i], heap[p]] = [heap[p], heap[i]];
      [heapF[i], heapF[p]] = [heapF[p], heapF[i]];
      [heapSeq[i], heapSeq[p]] = [heapSeq[p], heapSeq[i]];
      i = p;
    }
  };
  const heapPop = () => {
    const top = heap[0];
    const lastS = heap.pop();
    const lastF = heapF.pop();
    const lastQ = heapSeq.pop();
    if (heap.length > 0) {
      heap[0] = lastS;
      heapF[0] = lastF;
      heapSeq[0] = lastQ;
      let i = 0;
      for (;;) {
        let c = 2 * i + 1;
        if (c >= heap.length) break;
        if (c + 1 < heap.length && before(c + 1, c)) c++;
        if (!before(c, i)) break;
        [heap[i], heap[c]] = [heap[c], heap[i]];
        [heapF[i], heapF[c]] = [heapF[c], heapF[i]];
        [heapSeq[i], heapSeq[c]] = [heapSeq[c], heapSeq[i]];
        i = c;
      }
    }
    return top;
  };

  const occupied = new Uint8Array(size);
  // Two mark arrays sharing one stamp counter: `seen` holds the region of the state being
  // expanded while `mark` holds each successor's region, so a successor's flood can never
  // overwrite the marks the stand-square checks of the same expansion still rely on.
  const seen = new Int32Array(size);
  const mark = new Int32Array(size);
  const stack = new Int32Array(size);
  let stamp = 0;
  const best = new Map();
  const cur = new Int32Array(n);
  const nxt = new Int32Array(n);

  for (const b of startBoxes) occupied[b] = 1;
  const rep0 = floodRegion(w, wall, occupied, player, seen, ++stamp, stack);
  for (const b of startBoxes) occupied[b] = 0;
  const root = addState(startBoxes, -1, 0, rep0, -1, -1);
  best.set(keyOf(startBoxes, rep0), 0);
  heapPush(root, mode === 'astar' ? estimate(startBoxes) : estimate(startBoxes));

  let found = -1;
  let expanded = 0;
  while (heap.length > 0 && expanded < budget) {
    const s = heapPop();
    const g = sG[s];
    for (let i = 0; i < n; i++) cur[i] = sBoxes[s * n + i];
    // A stale heap entry: this state was since reached in fewer pushes.
    if (best.get(keyOf(cur, sRep[s])) !== g) continue;
    let solved = true;
    for (let i = 0; i < n; i++) if (!goalAt[cur[i]]) { solved = false; break; }
    if (solved) { found = s; break; }
    expanded++;
    for (let i = 0; i < n; i++) occupied[cur[i]] = 1;
    floodRegion(w, wall, occupied, sRep[s], seen, ++stamp, stack);
    const here = stamp;
    for (let bi = 0; bi < n; bi++) {
      const b = cur[bi];
      for (let k = 0; k < 4; k++) {
        const d = DIRS[k][1] * w + DIRS[k][0];
        const stand = b - d;
        const target = b + d;
        if (seen[stand] !== here || wall[target] || occupied[target] || dist[target] >= INF) continue;
        occupied[b] = 0;
        occupied[target] = 1;
        const frozen = frozenBlock(w, wall, occupied, goalAt, target);
        let rep = -1;
        if (!frozen) rep = floodRegion(w, wall, occupied, b, mark, ++stamp, stack);
        occupied[target] = 0;
        occupied[b] = 1;
        if (frozen) continue;
        nxt.set(cur);
        nxt[bi] = target;
        nxt.sort();
        const g2 = g + 1;
        const key = keyOf(nxt, rep);
        const known = best.get(key);
        if (known !== undefined && known <= g2) continue;
        best.set(key, g2);
        const child = addState(nxt, s, g2, rep, b, k);
        const h = estimate(nxt);
        heapPush(child, mode === 'astar' ? g2 + h : h);
      }
    }
    for (let i = 0; i < n; i++) occupied[cur[i]] = 0;
  }
  if (found < 0) return null;

  // Rebuild the moves: the chain of pushes, then for each one the walk to its stand square.
  const chain = [];
  for (let s = found; s > 0; s = sParent[s]) chain.push(s);
  chain.reverse();
  const boxesNow = new Int32Array(startBoxes);
  let playerNow = player;
  let moves = '';
  for (const s of chain) {
    const from = sFrom[s];
    const k = sDir[s];
    const d = DIRS[k][1] * w + DIRS[k][0];
    for (let i = 0; i < n; i++) occupied[boxesNow[i]] = 1;
    const walk = walkPath(w, wall, occupied, playerNow, from - d);
    for (let i = 0; i < n; i++) occupied[boxesNow[i]] = 0;
    if (walk === null) return null;
    moves += walk + DIRS[k][3];
    boxesNow[boxesNow.indexOf(from)] = from + d;
    playerNow = from;
  }
  return { pushes: chain.length, moves };
}

/** A move-by-move A* over the whole board (fewest steps): the last-resort solver that just answers. */
function searchMoves(level, budget) {
  const { w, wall, goals, boxes: startBoxes, player } = level;
  const size = wall.length;
  const n = startBoxes.length;
  const goalAt = new Uint8Array(size);
  for (const g of goals) goalAt[g] = 1;
  const dist = pushDistances(w, wall, goals);
  for (const b of startBoxes) if (dist[b] >= INF) return null;
  // Manhattan distance to the nearest goal, per square: the estimate's building block.
  const man = new Int32Array(size).fill(INF);
  for (let i = 0; i < size; i++) {
    if (wall[i]) continue;
    const x = i % w;
    const y = Math.floor(i / w);
    for (const g of goals) {
      const d = Math.abs(x - (g % w)) + Math.abs(y - Math.floor(g / w));
      if (d < man[i]) man[i] = d;
    }
  }
  const estimate = (bs) => {
    let s = 0;
    for (let i = 0; i < n; i++) s += man[bs[i]];
    return s;
  };
  const keyOf = (p, bs) => String.fromCharCode(p, ...bs);
  const statesP = [player];
  const statesB = [Int32Array.from(startBoxes)];
  const statesParent = [-1];
  const statesStep = [-1];
  const best = new Map([[keyOf(player, startBoxes), 0]]);
  const heap = [[estimate(startBoxes), 0, 0]];
  const before = (a, b) => a[0] < b[0] || (a[0] === b[0] && (a[1] > b[1] || (a[1] === b[1] && a[2] < b[2])));
  const heapPush = (e) => {
    heap.push(e);
    let i = heap.length - 1;
    while (i > 0) {
      const p = (i - 1) >> 1;
      if (!before(heap[i], heap[p])) break;
      [heap[i], heap[p]] = [heap[p], heap[i]];
      i = p;
    }
  };
  const heapPop = () => {
    const top = heap[0];
    const last = heap.pop();
    if (heap.length > 0) {
      heap[0] = last;
      let i = 0;
      for (;;) {
        let c = 2 * i + 1;
        if (c >= heap.length) break;
        if (c + 1 < heap.length && before(heap[c + 1], heap[c])) c++;
        if (!before(heap[c], heap[i])) break;
        [heap[i], heap[c]] = [heap[c], heap[i]];
        i = c;
      }
    }
    return top;
  };
  let expanded = 0;
  while (heap.length > 0 && expanded < budget) {
    const [, g, s] = heapPop();
    const p = statesP[s];
    const bs = statesB[s];
    if (best.get(keyOf(p, bs)) !== g) continue;
    if (bs.every((b) => goalAt[b])) {
      // Replay the chain of steps, marking the ones that push with the upper-case letter.
      const chain = [];
      for (let t = s; t > 0; t = statesParent[t]) chain.push(t);
      chain.reverse();
      const boxesNow = new Set(startBoxes);
      let playerNow = player;
      let out = '';
      for (const t of chain) {
        const k = statesStep[t];
        const d = DIRS[k][1] * w + DIRS[k][0];
        const next = playerNow + d;
        if (boxesNow.has(next)) {
          boxesNow.delete(next);
          boxesNow.add(next + d);
          out += DIRS[k][3];
        } else out += DIRS[k][2];
        playerNow = next;
      }
      return out;
    }
    expanded++;
    const occupied = new Set(bs);
    for (let k = 0; k < 4; k++) {
      const d = DIRS[k][1] * w + DIRS[k][0];
      const q = p + d;
      if (wall[q]) continue;
      let nb = bs;
      if (occupied.has(q)) {
        if (wall[q + d] || occupied.has(q + d) || dist[q + d] >= INF) continue;
        nb = Int32Array.from(bs);
        nb[nb.indexOf(q)] = q + d;
        nb.sort();
      }
      const key = keyOf(q, nb);
      const known = best.get(key);
      if (known !== undefined && known <= g + 1) continue;
      best.set(key, g + 1);
      statesP.push(q);
      statesB.push(nb);
      statesParent.push(s);
      statesStep.push(k);
      heapPush([g + 1 + estimate(nb), g + 1, statesP.length - 1]);
    }
  }
  return null;
}

/** Replay a move string on the whole board; returns the player's end square (boxes are updated in `boxSet`). */
function replayEnd(w, wall, boxSet, player, moves) {
  let p = player;
  for (const ch of moves) {
    const low = ch.toLowerCase();
    const k = low === 'u' ? 0 : low === 'd' ? 1 : low === 'l' ? 2 : 3;
    const d = DIRS[k][1] * w + DIRS[k][0];
    const next = p + d;
    if (boxSet.has(next)) {
      boxSet.delete(next);
      boxSet.add(next + d);
    }
    p = next;
  }
  return p;
}

/** Solve one level's text; returns the move string ('' when nothing better was found). */
function solveLevel(text) {
  const level = parseLevel(text);
  const { w, wall } = level;
  if (level.boxes.length === 0 || level.player < 0) return '';
  const rooms = decompose(level);
  if (rooms !== null) {
    let player = level.player;
    let moves = '';
    let ok = true;
    // The full box set as it stands, replayed room by room to follow the player and the boxes.
    const liveBoxes = new Set(level.boxes);
    for (const room of rooms) {
      const subWall = wall.slice();
      for (const other of rooms) {
        if (other === room) continue;
        for (const cell of other.done ? other.goals : other.boxes) subWall[cell] = 1;
      }
      const sub = {
        w,
        wall: subWall,
        goals: room.goals.slice().sort((a, b) => a - b),
        boxes: room.boxes.slice().sort((a, b) => a - b),
        player,
      };
      let sol = searchPushes(sub, 'astar', ROOM_ASTAR_BUDGET);
      if (sol === null) sol = searchPushes(sub, 'greedy', ROOM_GREEDY_BUDGET);
      if (sol === null) { ok = false; break; }
      moves += sol.moves;
      player = replayEnd(w, wall, liveBoxes, player, sol.moves);
      room.done = true;
    }
    if (ok) return moves;
  }
  const whole = searchPushes(
    { w, wall, goals: level.goals, boxes: level.boxes, player: level.player },
    'astar',
    BOARD_ASTAR_BUDGET,
  );
  if (whole !== null) return whole.moves;
  const anyMoves = searchMoves(level, MOVE_ASTAR_BUDGET);
  if (anyMoves !== null) return anyMoves;
  return '';
}

for (const id of readdirSync(INPUT_DIR).sort()) {
  let text;
  try {
    text = readFileSync(join(INPUT_DIR, id, 'level.txt'), 'utf8');
  } catch {
    continue;
  }
  const moves = solveLevel(text);
  mkdirSync(join(OUTPUT_DIR, id), { recursive: true });
  writeFileSync(join(OUTPUT_DIR, id, 'solution.txt'), `${moves}\n`);
}
