// Drywall (ГКЛ) cutting-stock planner — pure logic, no DOM / no Three.js.
// The caller builds surface descriptors from the room; this module tiles them,
// cuts out door/arch openings, and packs every required piece using a shared
// pool of offcuts (including the door/arch cut-outs) to minimise new sheets.

import { round2 } from './utils.js?v=2';

const EPS = 1e-3;
const MIN_SIDE = 0.15;  // ignore offcuts thinner than this (m)
const MIN_AREA = 0.06;  // ignore offcuts smaller than this (m²)

// Tile a W×H surface with sw×sh sheets. orient: 'h'|'v'|'auto'; stagger: brick.
export function drywallLayout(W, H, sw, sh, orient, stagger) {
  const A = { cw: sw, ch: sh };
  const B = { cw: sh, ch: sw };
  let opt;
  if (orient === 'h') opt = A;
  else if (orient === 'v') opt = B;
  else {
    const na = Math.ceil(W / A.cw) * Math.ceil(H / A.ch);
    const nb = Math.ceil(W / B.cw) * Math.ceil(H / B.ch);
    opt = nb < na ? B : A;
  }
  const cells = [];
  let y = 0;
  let row = 0;
  while (y < H - 1e-6) {
    const h = Math.min(opt.ch, H - y);
    let x = 0;
    while (x < W - 1e-6) {
      const full = (x === 0 && stagger && row % 2 === 1) ? opt.cw / 2 : opt.cw;
      const w = Math.min(full, W - x);
      cells.push({ x, y, w, h, cut: w < opt.cw - 1e-6 || h < opt.ch - 1e-6 });
      x += full;
    }
    y += opt.ch;
    row++;
  }
  return { opt, cells };
}

// Overlap area of a tile [x..x+w, y..y+h] with an opening rect {x0,x1,y0,y1}.
function overlap(x, y, w, h, o) {
  const iw = Math.max(0, Math.min(x + w, o.x1) - Math.max(x, o.x0));
  const ih = Math.max(0, Math.min(y + h, o.y1) - Math.max(y, o.y0));
  return { w: iw, h: ih, area: iw * ih };
}

// Build the flat list of required pieces across all surfaces.
function buildPieces(surfaces, sw, sh, orient, stagger) {
  const pieces = [];
  surfaces.forEach((surf, si) => {
    const { cells } = drywallLayout(surf.W, surf.H, sw, sh, orient, stagger);
    cells.forEach((c) => {
      let openArea = 0;
      const cutouts = [];
      const holes = []; // opening rects clipped to this tile, in tile-local coords
      (surf.openings || []).forEach((o) => {
        const r = overlap(c.x, c.y, c.w, c.h, o);
        if (r.area > 1e-4) {
          openArea += r.area;
          cutouts.push({ w: round2(r.w), h: round2(r.h) });
          holes.push({
            x0: Math.max(0, o.x0 - c.x), x1: Math.min(c.w, o.x1 - c.x),
            y0: Math.max(0, o.y0 - c.y), y1: Math.min(c.h, o.y1 - c.y),
          });
        }
      });
      openArea = Math.min(openArea, c.w * c.h);
      pieces.push({
        si, x: c.x, y: c.y, w: c.w, h: c.h,
        isFull: !c.cut, openArea, cutouts, holes, net: c.w * c.h - openArea,
      });
    });
  });
  return pieces;
}

// A shared pool of rectangular offcuts, with guillotine splitting and best-fit
// search. Offcuts may be cut in any order (global best-fit over the whole pool).
// Each offcut carries `from` = the source sheet's id, so we can report which
// panel a reused/leftover piece was cut from.
function makePool(minSide = MIN_SIDE, minArea = MIN_AREA) {
  const pool = [];
  // Source sheets whose offcuts have already been used elsewhere — such a sheet
  // can no longer be eliminated (something depends on its leftover material).
  const consumedFrom = new Set();
  const markConsumed = (from) => { if (from != null) consumedFrom.add(from); };

  const add = (w, h, from) => {
    w = round2(w); h = round2(h);
    if (w >= minSide && h >= minSide && w * h >= minArea) pool.push({ w, h, from });
  };

  // Guillotine-split a source rect (W×H) after cutting a (pw×ph) corner piece.
  // Pick the cut direction that keeps the larger remaining rectangle intact.
  const split = (W, H, pw, ph, from) => {
    if (!(pw <= W + EPS && ph <= H + EPS)) { const t = pw; pw = ph; ph = t; } // rotate to fit
    const rightW = W - pw;
    const topH = H - ph;
    const optA = Math.max(rightW * H, pw * topH); // cut full-height right strip first
    const optB = Math.max(rightW * ph, W * topH); // cut full-width top strip first
    if (optA >= optB) { add(rightW, H, from); add(pw, topH, from); }
    else { add(rightW, ph, from); add(W, topH, from); }
  };

  // Best-fit offcut for a (w×h) piece (either orientation); least leftover wins.
  const take = (w, h) => {
    let best = -1;
    let bestWaste = Infinity;
    let bestRot = false;
    for (let i = 0; i < pool.length; i++) {
      const o = pool[i];
      const waste = o.w * o.h - w * h;
      if (o.w + EPS >= w && o.h + EPS >= h && waste < bestWaste) {
        best = i; bestWaste = waste; bestRot = false;
      }
      if (o.w + EPS >= h && o.h + EPS >= w && waste < bestWaste) {
        best = i; bestWaste = waste; bestRot = true;
      }
    }
    if (best < 0) return null;
    const o = pool.splice(best, 1)[0];
    markConsumed(o.from);
    return { o, rot: bestRot };
  };

  const list = () => pool.slice();
  const isConsumed = (from) => consumedFrom.has(from);

  // Remove & return all offcuts that came from sheet `from` (for rollback).
  const removeFrom = (from) => {
    const out = [];
    for (let i = pool.length - 1; i >= 0; i--) {
      if (pool[i].from === from) out.push(pool.splice(i, 1)[0]);
    }
    return out;
  };
  const restore = (arr) => { arr.forEach((o) => pool.push(o)); };

  // Consume specific offcuts (by index into a prior list() snapshot).
  const consume = (idxs) => {
    idxs.slice().sort((a, b) => b - a).forEach((i) => {
      const o = pool.splice(i, 1)[0];
      if (o) markConsumed(o.from);
    });
  };

  const leftover = () => pool.reduce((s, o) => s + o.w * o.h, 0);
  return { add, split, take, list, leftover, isConsumed, removeFrom, restore, consume };
}

// Decompose a footprint (w×h) minus its opening holes into a set of rectangles
// (vertical slabs). These are the areas that actually need drywall.
function decomposeNet(w, h, holes) {
  const xs = new Set([0, w]);
  (holes || []).forEach((o) => {
    if (o.x0 > EPS) xs.add(round2(o.x0));
    if (o.x1 < w - EPS) xs.add(round2(o.x1));
  });
  const xa = [...xs].filter((x) => x >= -EPS && x <= w + EPS).sort((a, b) => a - b);
  const rects = [];
  for (let i = 0; i < xa.length - 1; i++) {
    const x0 = xa[i];
    const x1 = xa[i + 1];
    const sw = x1 - x0;
    if (sw <= EPS) continue;
    const blocked = []; // y-intervals of holes spanning this slab
    (holes || []).forEach((o) => {
      if (o.x0 <= x0 + EPS && o.x1 >= x1 - EPS) blocked.push([Math.max(0, o.y0), Math.min(h, o.y1)]);
    });
    blocked.sort((a, b) => a[0] - b[0]);
    let y = 0;
    for (const [b0, b1] of blocked) {
      if (b0 > y + EPS) rects.push({ w: sw, h: b0 - y });
      y = Math.max(y, b1);
    }
    if (h > y + EPS) rects.push({ w: sw, h: h - y });
  }
  return rects;
}

// Positioned variant of decomposeNet: split a whole W×H surface minus its
// openings into rectangles carrying their surface coordinates {x, y, w, h}.
function decomposeNetPos(W, H, openings) {
  const xs = new Set([0, W]);
  (openings || []).forEach((o) => {
    if (o.x0 > EPS) xs.add(round2(Math.max(0, o.x0)));
    if (o.x1 < W - EPS) xs.add(round2(Math.min(W, o.x1)));
  });
  const xa = [...xs].sort((a, b) => a - b);
  const rects = [];
  for (let i = 0; i < xa.length - 1; i++) {
    const x0 = xa[i];
    const x1 = xa[i + 1];
    const sw = x1 - x0;
    if (sw <= EPS) continue;
    const blocked = [];
    (openings || []).forEach((o) => {
      if (o.x0 <= x0 + EPS && o.x1 >= x1 - EPS) blocked.push([Math.max(0, o.y0), Math.min(H, o.y1)]);
    });
    blocked.sort((a, b) => a[0] - b[0]);
    let y = 0;
    for (const [b0, b1] of blocked) {
      if (b0 > y + EPS) rects.push({ x: x0, y, w: sw, h: b0 - y });
      y = Math.max(y, b1);
    }
    if (H > y + EPS) rects.push({ x: x0, y, w: sw, h: H - y });
  }
  return rects;
}

// Economy planner ("економія понад усе"): covers only the net area (openings
// carved out up-front, no material ever crosses an opening), slices regions
// into sheet-sized pieces picking the orientation with fewer pieces, then
// packs everything largest-first through a shared offcut pool that keeps even
// small scraps. Seams are NOT staggered — that is the price of minimal waste.
const ECON_MIN_SIDE = 0.04;   // keep scraps down to 4 cm strips
const ECON_MIN_AREA = 0.0025; // and 25 cm² patches
function planEcon({ sw, sh, surfaces }) {
  // Try three slicing strategies (per-region best / all horizontal / all
  // vertical) and keep the one buying the fewest sheets, then least leftover.
  let best = null;
  for (const mode of ['best', 'h', 'v']) {
    const plan = planEconOnce({ sw, sh, surfaces, mode });
    if (!best || plan.newSheets < best.newSheets ||
        (plan.newSheets === best.newSheets && plan.leftover < best.leftover)) best = plan;
  }
  return best;
}

function planEconOnce({ sw, sh, surfaces, mode }) {
  const pieces = [];
  surfaces.forEach((surf, si) => {
    const regions = decomposeNetPos(surf.W, surf.H, surf.openings);
    regions.forEach((r) => {
      // Choose slicing orientation per region: fewer pieces, then less cut length.
      const optA = { cw: sw, ch: sh };
      const optB = { cw: sh, ch: sw };
      const cnt = (o) => Math.ceil(r.w / o.cw - EPS) * Math.ceil(r.h / o.ch - EPS);
      const opt = mode === 'h' ? optA : mode === 'v' ? optB : (cnt(optB) < cnt(optA) ? optB : optA);
      for (let y = 0; y < r.h - EPS; y += opt.ch) {
        const h = Math.min(opt.ch, r.h - y);
        for (let x = 0; x < r.w - EPS; x += opt.cw) {
          const w = Math.min(opt.cw, r.w - x);
          pieces.push({
            si, x: r.x + x, y: r.y + y, w, h,
            isFull: w >= opt.cw - EPS && h >= opt.ch - EPS,
            openArea: 0, cutouts: [], holes: [], net: w * h,
          });
        }
      }
    });
  });

  const pool = makePool(ECON_MIN_SIDE, ECON_MIN_AREA);
  let newSheets = 0;
  let reused = 0;
  let assembledEarly = 0;
  let pid = 0;
  pieces.sort((a, b) => (b.w * b.h) - (a.w * a.h)).forEach((p) => {
    if (p.isFull) {
      p.status = 'full';
      p.pid = ++pid;
      newSheets += 1;
      return;
    }
    const hit = pool.take(p.w, p.h);
    if (hit) {
      reused += 1;
      p.status = 'offcut';
      p.fromPid = hit.o.from;
      const pw = hit.rot ? p.h : p.w;
      const ph = hit.rot ? p.w : p.h;
      pool.split(hit.o.w, hit.o.h, pw, ph, hit.o.from);
      return;
    }
    // No single offcut fits — try assembling this piece from several scraps
    // before buying a new sheet ("навіть дрібні" reuse).
    const cover = coverRegion([{ w: p.w, h: p.h }], pool.list());
    if (cover) {
      pool.consume(cover.idxs);
      p.status = 'patched';
      p.builtFromPids = cover.fromPids.filter((x) => x != null);
      assembledEarly += 1;
      return;
    }
    newSheets += 1;
    p.status = 'cut';
    p.pid = ++pid;
    pool.split(sw, sh, p.w, p.h, p.pid);
  });

  // Elimination pass: rebuild the least-used bought sheets from scraps, so a
  // sheet only stays bought when its area truly cannot be pieced together.
  let assembled = assembledEarly;
  let improved = true;
  let guard = 0;
  while (improved && guard++ < 1000) {
    improved = false;
    const cands = pieces
      .filter((p) => p.status === 'cut' && p.pid != null && !pool.isConsumed(p.pid))
      .sort((a, b) => a.net - b.net);
    for (const p of cands) {
      const removed = pool.removeFrom(p.pid);
      const cover = coverRegion([{ w: p.w, h: p.h }], pool.list());
      if (cover) {
        pool.consume(cover.idxs);
        p.status = 'patched';
        p.builtFromPids = cover.fromPids.filter((x) => x != null);
        newSheets -= 1;
        assembled += 1;
        improved = true;
        break;
      }
      pool.restore(removed);
    }
  }

  // Stable reading-order numbering (by surface, then row, then column).
  pieces.sort((a, b) => a.si - b.si || a.y - b.y || a.x - b.x);
  let num = 0;
  pieces.forEach((p) => { num += 1; p.num = num; });
  const pidToNum = {};
  pieces.forEach((p) => { if (p.pid != null) pidToNum[p.pid] = p.num; });
  pieces.forEach((p) => { if (p.fromPid != null) p.fromNum = pidToNum[p.fromPid]; });
  pieces.forEach((p) => {
    if (p.builtFromPids) {
      p.builtFromNums = [...new Set(p.builtFromPids.map((x) => pidToNum[x]).filter((n) => n != null))];
    }
  });

  const offcuts = pool.list()
    .map((o) => ({ w: o.w, h: o.h, fromNum: pidToNum[o.from] }))
    .sort((a, b) => (b.w * b.h) - (a.w * a.h));
  return { cells: pieces, newSheets, reused, assembled, skipped: 0, offcuts, leftover: round2(pool.leftover()) };
}

// Can a single w×h rectangle be tiled by a subset of `rects` (leftovers) via
// guillotine cuts (each leftover used once, trimmed as needed)? Backtracking
// search bounded by an op limit. Returns the used indices or null.
function coverRect(w, h, rects, used, ops) {
  if (w <= EPS || h <= EPS) return [];
  if (ops.n++ > ops.limit) return null;
  // 1) cover the whole rect with one leftover (smallest sufficient → save big ones).
  let single = -1;
  let bestA = Infinity;
  for (let i = 0; i < rects.length; i++) {
    if (used[i]) continue;
    const o = rects[i];
    if (((o.w + EPS >= w && o.h + EPS >= h) || (o.h + EPS >= w && o.w + EPS >= h)) && o.w * o.h < bestA) {
      bestA = o.w * o.h; single = i;
    }
  }
  if (single >= 0) { used[single] = true; return [single]; }
  // 2) guillotine cut: try each distinct leftover dimension as a cut line.
  const ws = new Set();
  const hs = new Set();
  for (let i = 0; i < rects.length; i++) {
    if (used[i]) continue;
    [rects[i].w, rects[i].h].forEach((d) => {
      if (d > EPS && d < w - EPS) ws.add(round2(d));
      if (d > EPS && d < h - EPS) hs.add(round2(d));
    });
  }
  for (const cw of ws) {
    const a = coverRect(cw, h, rects, used, ops);
    if (a) {
      const b = coverRect(w - cw, h, rects, used, ops);
      if (b) return a.concat(b);
      a.forEach((i) => { used[i] = false; }); // rollback left
    }
  }
  for (const ch of hs) {
    const a = coverRect(w, ch, rects, used, ops);
    if (a) {
      const b = coverRect(w, h - ch, rects, used, ops);
      if (b) return a.concat(b);
      a.forEach((i) => { used[i] = false; });
    }
  }
  return null;
}

// Cover a whole net region (list of rectangles) from a pool snapshot, using each
// offcut at most once. Returns { idxs, fromPids } or null.
function coverRegion(regionRects, rects) {
  const used = new Array(rects.length).fill(false);
  const ops = { n: 0, limit: 60000 };
  const idxs = [];
  for (const rr of regionRects) {
    const got = coverRect(rr.w, rr.h, rects, used, ops);
    if (!got) return null;
    idxs.push(...got);
  }
  return { idxs, fromPids: idxs.map((i) => rects[i].from) };
}

// Main entry: returns { cells, newSheets, reused, assembled, skipped, offcuts, leftover }.
// cells carry { si, x, y, w, h, status, num, cutouts } for rendering.
// status ∈ 'full' | 'full-hole' | 'cut' | 'offcut' | 'patched' | 'skip'.
// When `useLeftovers` is on, an extra pass eliminates the least-used new sheets
// by re-building them from leftover strips (status 'patched').
export function planDrywall({ sw, sh, orient, stagger, surfaces, useLeftovers = false }) {
  if (orient === 'econ') return planEcon({ sw, sh, surfaces });
  const pieces = buildPieces(surfaces, sw, sh, orient, stagger);
  const pool = makePool();
  let newSheets = 0;
  let reused = 0;
  let assembled = 0;
  let pid = 0; // id assigned to every newly-bought sheet (source of offcuts)

  // Pass 1: full-size sheets. Each needs a brand-new sheet; a door/arch cut-out
  // inside it becomes reusable material seeded into the pool (tagged with pid).
  pieces.filter((p) => p.net > EPS && p.isFull).forEach((p) => {
    p.status = p.openArea > EPS ? 'full-hole' : 'full';
    p.pid = ++pid;
    newSheets += 1;
    p.cutouts.forEach((r) => pool.add(r.w, r.h, p.pid));
  });

  // Pass 2: edge pieces, largest first (first-fit-decreasing). Reuse an offcut
  // when one fits; otherwise open a new sheet and return its remainder to pool.
  pieces.filter((p) => p.net > EPS && !p.isFull)
    .sort((a, b) => (b.w * b.h) - (a.w * a.h))
    .forEach((p) => {
      const hit = pool.take(p.w, p.h);
      let src;
      if (hit) {
        reused += 1;
        p.status = 'offcut';
        p.fromPid = hit.o.from; // panel this offcut originally came from
        src = hit.o.from;
        const pw = hit.rot ? p.h : p.w;
        const ph = hit.rot ? p.w : p.h;
        pool.split(hit.o.w, hit.o.h, pw, ph, src);
      } else {
        newSheets += 1;
        p.status = 'cut';
        p.pid = ++pid;
        src = p.pid;
        pool.split(sw, sh, p.w, p.h, src);
      }
      // This edge piece's own door/arch cut-out is also reusable.
      p.cutouts.forEach((r) => pool.add(r.w, r.h, src));
    });

  // Optional pass: eliminate the least-used new sheets by assembling their net
  // area (footprint minus door/arch holes) from leftover pieces. Targets bought
  // sheets with the smallest used area first; only a sheet whose own offcuts are
  // all still unused can go.
  if (useLeftovers) {
    let improved = true;
    let guard = 0;
    while (improved && guard++ < 1000) {
      improved = false;
      const cands = pieces
        .filter((p) => (p.status === 'cut' || p.status === 'full' || p.status === 'full-hole')
          && p.net > EPS && p.pid != null && !pool.isConsumed(p.pid))
        .sort((a, b) => a.net - b.net);
      for (const p of cands) {
        const removed = pool.removeFrom(p.pid); // this sheet leaves with its offcuts
        const region = decomposeNet(p.w, p.h, p.holes);
        const cover = coverRegion(region, pool.list());
        if (cover) {
          pool.consume(cover.idxs);
          p.status = 'patched';
          p.builtFromPids = cover.fromPids.filter((x) => x != null);
          newSheets -= 1;
          assembled += 1;
          improved = true;
          break; // pool changed → restart the scan
        }
        pool.restore(removed); // rollback: keep the sheet
      }
    }
  }

  // Pieces fully inside an opening need no material.
  pieces.forEach((p) => { if (p.net <= EPS) p.status = 'skip'; });

  // Number the material pieces in reading order for stable display.
  let num = 0;
  pieces.forEach((p) => { if (p.status !== 'skip') { num += 1; p.num = num; } });

  // Map each source sheet's pid → its display number, then resolve provenance.
  const pidToNum = {};
  pieces.forEach((p) => { if (p.pid != null) pidToNum[p.pid] = p.num; });
  pieces.forEach((p) => { if (p.fromPid != null) p.fromNum = pidToNum[p.fromPid]; });
  pieces.forEach((p) => {
    if (p.builtFromPids) {
      p.builtFromNums = [...new Set(p.builtFromPids.map((x) => pidToNum[x]).filter((n) => n != null))];
    }
  });

  // Leftover offcuts, reported as full panels with the panel they were cut from.
  const offcuts = pool.list()
    .map((o) => ({ w: o.w, h: o.h, fromNum: pidToNum[o.from] }))
    .sort((a, b) => (b.w * b.h) - (a.w * a.h));

  const skipped = pieces.filter((p) => p.status === 'skip').length;
  return { cells: pieces, newSheets, reused, assembled, skipped, offcuts, leftover: round2(pool.leftover()) };
}
