#!/usr/bin/env node
// Balance simulation harness (DESIGN §17.17). Slow and statistical — NOT part of `npm test` (see test/balance.test.js
// for the fast banded companion that is).
//
//   npm run sim
//   node tools/sim.js --depths 1-20 --runs 500 [--explore 0.7] [--floor-depths 1-30] [--seed 1] [--no-buy]
//                     [--no-treasure] [--json out.json] [--compare test/sim/baseline.json] [--threshold 0.1] [--quiet]
//
// Layer 1 (floor statistics): --runs floors per depth over --floor-depths (default 1-30).
// Layer 2 (run economy):      --runs full runs over --depths (default 1-20), --explore of each floor (default 0.7).
// --no-treasure: Layer 2 counterfactual where the policy never opens a chest (what the treasure tiers add).
// --json writes every per-depth mean/p10/p50/p90 to a file; --compare diffs the current means against such a file and
// flags anything that moved more than --threshold (relative, default 10%). Timing metrics are never flagged (machine-
// dependent). The baseline is written with the same seed, so an unchanged codebase compares at exactly 0 drift.
import { writeFileSync, readFileSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { floorSample, simulateRun, summarize, mixSeed, designTreasureItems, ECON_DEFAULTS } from './simlib.js';

// ---------------------------------------------------------------------------
// Args
// ---------------------------------------------------------------------------
function parseArgs(argv) {
  const a = { depths: [1, 20], floorDepths: [1, 30], runs: 500, explore: ECON_DEFAULTS.explore, seed: 1, buy: true,
    json: null, compare: null, threshold: 0.1, quiet: false, treasure: true };
  const range = (s) => { const m = /^(\d+)(?:-(\d+))?$/.exec(s || ''); if (!m) throw new Error(`bad range "${s}"`); return [+m[1], +(m[2] || m[1])]; };
  for (let i = 0; i < argv.length; i++) {
    const k = argv[i], v = () => argv[++i];
    if (k === '--depths') a.depths = range(v());
    else if (k === '--floor-depths') a.floorDepths = range(v());
    else if (k === '--runs') a.runs = Math.max(1, parseInt(v(), 10));
    else if (k === '--explore') a.explore = Math.min(1, Math.max(0, parseFloat(v())));
    else if (k === '--seed') a.seed = parseInt(v(), 10) >>> 0;
    else if (k === '--no-buy') a.buy = false;
    else if (k === '--no-treasure') a.treasure = false;
    else if (k === '--json') a.json = v();
    else if (k === '--compare') a.compare = v();
    else if (k === '--threshold') a.threshold = parseFloat(v());
    else if (k === '--quiet') a.quiet = true;
    else if (k === '--help' || k === '-h') { console.log(readFileSync(new URL(import.meta.url)).toString().split('\n').slice(1, 15).join('\n')); process.exit(0); }
    else throw new Error(`unknown argument "${k}"`);
  }
  return a;
}

// ---------------------------------------------------------------------------
// Run
// ---------------------------------------------------------------------------
const args = parseArgs(process.argv.slice(2));
const t0 = performance.now();

// Layer 1 ---------------------------------------------------------------
const FLOOR_METRICS = ['rooms', 'baseRooms', 'populatedFloor', 'width', 'height', 'enemiesGeneral', 'density', 'densityTarget',
  'eliteShare', 'exitSentries', 'treasureGuards', 'bossGuards', 'enemiesTotal', 'treasureRooms', 'cache', 'hoard', 'vault',
  'antechambers', 'hidden', 'chests', 'treasureItems', 'chestGold', 'chestPotions', 'booksHidden', 'mobGold', 'mobPotions',
  'mobItems', 'booksBoss', 'arenaFloor', 'arenaClearCore', 'arenaLong', 'arenaShort', 'genMs'];
const floor = {};
const allGen = [];
for (let d = args.floorDepths[0]; d <= args.floorDepths[1]; d++) {
  const rows = [];
  for (let i = 0; i < args.runs; i++) rows.push(floorSample(d, mixSeed(args.seed, d, i)));
  const agg = {};
  for (const m of FLOOR_METRICS) { const s = summarize(rows.map((r) => r[m])); if (s) agg[m] = s; }
  // ratio / pooled metrics
  const sum = (k) => rows.reduce((a, r) => a + r[k], 0);
  agg.wingFailRate = { mean: 1 - sum('wingsPlaced') / Math.max(1, sum('wingsRolled')) };
  agg.anteFailRate = { mean: sum('anteRolled') ? 1 - sum('antePlaced') / sum('anteRolled') : 0 };
  agg.hiddenBookRate = { mean: rows.filter((r) => r.booksHidden > 0).length / rows.length };
  agg.designTreasureItems = { mean: designTreasureItems(d) };
  const rar = [0, 0, 0, 0, 0];
  for (const r of rows) r.treasureRarity.forEach((n, j) => { rar[j] += n; });
  const rtot = rar.reduce((a, b) => a + b, 0) || 1;
  ['common', 'magic', 'rare', 'epic', 'legendary'].forEach((k, j) => { agg[`tr_${k}`] = { mean: rar[j] / rtot }; });
  for (const tier of ['cache', 'hoard', 'vault']) {
    const offs = rows.flatMap((r) => r.levelOffsets[tier]);
    if (offs.length) agg[`ilvlOff_${tier}`] = { ...summarize(offs), min: Math.min(...offs), max: Math.max(...offs) };
  }
  for (const r of rows) allGen.push(r.genMs);
  floor[d] = agg;
}
const genAll = summarize(allGen);

// Layer 2 ---------------------------------------------------------------
const ECON_METRICS = ['income', 'goldMob', 'goldChest', 'sellIncome', 'goldOnHand', 'affordRegular', 'affordFeatured',
  'affordAny', 'affordTogether', 'cheapestPrice', 'featuredPrice', 'stockTotal', 'onHandVsFeatured', 'goldVsCheapest', 'stockUpgrades', 'bought', 'spent',
  'goldAfter', 'itemsLooted', 'potionsLooted', 'books', 'bossBooks', 'bagMax', 'overflow', 'overflowValue', 'killed',
  'chestsOpened', 'treasureReached', 'treasureRooms', 'gearIlvl', 'gearValue', 'gearRarity', 'melee', 'defense', 'maxHp', 'level',
  'levelMinusDepth'];
const econRows = {};
for (let d = args.depths[0]; d <= args.depths[1]; d++) econRows[d] = [];
for (let i = 0; i < args.runs; i++) {
  const run = simulateRun(mixSeed(args.seed ^ 0xA5A5A5A5, 0, i), { depths: args.depths[1], explore: args.explore, buy: args.buy, treasure: args.treasure });
  for (const rec of run) if (econRows[rec.depth]) econRows[rec.depth].push(rec);
}
const economy = {};
for (const [d, rows] of Object.entries(econRows)) {
  const agg = {};
  for (const m of ECON_METRICS) { const s = summarize(rows.map((r) => r[m])); if (s) agg[m] = s; }
  agg.bagFullRate = { mean: rows.filter((r) => r.overflow > 0).length / rows.length };
  economy[d] = agg;
}
const elapsed = (performance.now() - t0) / 1000;

// ---------------------------------------------------------------------------
// Print
// ---------------------------------------------------------------------------
const f = (v, dp = 1) => (v == null || !Number.isFinite(v) ? '-' : v.toFixed(dp));
const mpp = (s, dp = 1) => (s ? `${f(s.mean, dp)} [${f(s.p10, dp)}-${f(s.p90, dp)}]` : '-');
const pct = (v) => (v == null || !Number.isFinite(v) ? '-' : `${(v * 100).toFixed(0)}%`);
function table(title, header, rows) {
  const w = header.map((h, i) => Math.max(h.length, ...rows.map((r) => String(r[i]).length)));
  const line = (cells) => cells.map((c, i) => String(c).padStart(w[i])).join('  ');
  console.log(`\n${title}`);
  console.log(line(header));
  console.log(w.map((n) => '-'.repeat(n)).join('  '));
  for (const r of rows) console.log(line(r));
}

if (!args.quiet) {
  console.log(`Depths of the Maze — balance sim (DESIGN §17.17). runs=${args.runs} seed=${args.seed} explore=${args.explore} buy=${args.buy}${args.treasure ? '' : ' NO-TREASURE (counterfactual: chests never opened)'}`);
  console.log('Cells are mean [p10-p90] unless marked.');
  const F = Object.entries(floor);
  table('LAYER 1a — floor shape & population (per floor)',
    ['depth', 'rooms', 'popFloor', 'map WxH', 'general', 'density', 'target', 'elite', 'sentry', 'trGuard', 'bossGrd', 'total'],
    F.map(([d, a]) => [d, f(a.rooms.mean), mpp(a.populatedFloor, 0), `${f(a.width.mean, 0)}x${f(a.height.mean, 0)}`,
      mpp(a.enemiesGeneral), mpp(a.density, 2), f(a.densityTarget.mean, 2), pct(a.eliteShare.mean), f(a.exitSentries.mean),
      f(a.treasureGuards.mean), f(a.bossGuards.mean), f(a.enemiesTotal.mean)]));
  table('LAYER 1b — treasure (per floor; ilvl offset = itemLevel - depth, min..max seen)',
    ['depth', 'rooms', 'C/H/V', 'ante', 'chests', 'items', 'design', 'rare+', 'ilvl C', 'ilvl H', 'ilvl V', 'wingFail', 'anteFail', 'hidden'],
    F.map(([d, a]) => {
      const o = (k) => (a[k] ? `${f(a[k].mean, 2)} (${a[k].min}..${a[k].max})` : '-');
      return [d, f(a.treasureRooms.mean, 2), `${f(a.cache.mean, 2)}/${f(a.hoard.mean, 2)}/${f(a.vault.mean, 2)}`,
        f(a.antechambers.mean, 2), f(a.chests.mean, 2), mpp(a.treasureItems), f(a.designTreasureItems.mean),
        pct(a.tr_rare.mean + a.tr_epic.mean + a.tr_legendary.mean), o('ilvlOff_cache'), o('ilvlOff_hoard'), o('ilvlOff_vault'),
        pct(a.wingFailRate.mean), pct(a.anteFailRate.mean), pct(a.hiddenBookRate.mean)];
    }));
  table('LAYER 1c — gold / potions / items / books by source (per floor, full clear)',
    ['depth', 'mobGold', 'chestGold', 'mobPot', 'chestPot', 'mobItems', 'chestItems', 'bk hidden', 'bk boss', 'arena floor', 'clear core', 'genMs p50/p99'],
    F.map(([d, a]) => [d, mpp(a.mobGold, 0), mpp(a.chestGold, 0), f(a.mobPotions.mean), f(a.chestPotions.mean),
      f(a.mobItems.mean), f(a.treasureItems.mean), f(a.booksHidden.mean, 2), f(a.booksBoss.mean, 2),
      a.arenaFloor ? mpp(a.arenaFloor, 0) : '-', a.arenaClearCore ? `${f(a.arenaClearCore.p10, 0)}x..${f(a.arenaClearCore.p90, 0)}x` : '-',
      `${f(a.genMs.p50, 2)}/${f(a.genMs.p99, 2)}`]));
  console.log(`\nGeneration time over all ${genAll.n} floors: p50 ${f(genAll.p50, 2)} ms, p99 ${f(genAll.p99, 2)} ms, mean ${f(genAll.mean, 2)} ms`);

  const E = Object.entries(economy);
  table(`LAYER 2a — run economy, gold (explore ${args.explore}; gold on hand = after selling, before buying)`,
    ['depth', 'income', 'mob', 'chest', 'sold', 'onHand', 'cheapest', 'featured', 'stock$', 'hand/feat', 'afford 4reg', 'featOK', 'anyOK', 'together', 'upgrades', 'bought', 'after'],
    E.map(([d, a]) => [d, mpp(a.income, 0), f(a.goldMob.mean, 0), f(a.goldChest.mean, 0), f(a.sellIncome.mean, 0),
      mpp(a.goldOnHand, 0), f(a.cheapestPrice.mean, 0), f(a.featuredPrice.mean, 0), f(a.stockTotal.mean, 0),
      f(a.onHandVsFeatured.mean, 2), mpp(a.affordRegular, 2),
      pct(a.affordFeatured.mean), pct(a.affordAny.mean), f(a.affordTogether.mean, 2), f(a.stockUpgrades.mean, 2),
      f(a.bought.mean, 2), f(a.goldAfter.mean, 0)]));
  table('LAYER 2b — run economy, character (level target: ~1 level per floor, §16)',
    ['depth', 'level', 'lvl-depth', 'killed', 'items', 'potions', 'books', 'trReached', 'bagMax', 'bagFull', 'overflow', 'lostGold', 'gear ilvl', 'gearValue', 'gearRar', 'melee', 'def', 'maxHp'],
    E.map(([d, a]) => [d, mpp(a.level), f(a.levelMinusDepth.mean, 2), f(a.killed.mean), f(a.itemsLooted.mean),
      f(a.potionsLooted.mean), f(a.books.mean, 2), `${f(a.treasureReached.mean, 2)}/${f(a.treasureRooms.mean, 2)}`,
      mpp(a.bagMax, 0), pct(a.bagFullRate.mean), f(a.overflow.mean, 2), f(a.overflowValue.mean, 0), mpp(a.gearIlvl),
      f(a.gearValue.mean, 0), f(a.gearRarity.mean, 2), f(a.melee.mean), f(a.defense.mean), f(a.maxHp.mean, 0)]));
  console.log(`\nDone in ${elapsed.toFixed(1)} s.`);
}

// ---------------------------------------------------------------------------
// JSON + compare
// ---------------------------------------------------------------------------
const round = (o) => JSON.parse(JSON.stringify(o, (k, v) => (typeof v === 'number' ? +v.toFixed(4) : v)));
const result = round({
  meta: { tool: 'tools/sim.js', section: 'DESIGN §17.17', runs: args.runs, seed: args.seed, explore: args.explore, buy: args.buy, treasure: args.treasure,
    depths: args.depths, floorDepths: args.floorDepths },
  generation: genAll,
  floor, economy,
});
if (args.json) {
  mkdirSync(dirname(args.json), { recursive: true });
  writeFileSync(args.json, JSON.stringify(result, null, 1) + '\n');
  console.log(`Wrote ${args.json}`);
}
if (args.compare) {
  const base = JSON.parse(readFileSync(args.compare, 'utf8'));
  const TIMING = /ms$/i;
  const flagged = [];
  let compared = 0;
  for (const layer of ['floor', 'economy']) {
    for (const [d, metrics] of Object.entries(result[layer])) {
      const bm = base[layer] && base[layer][d];
      if (!bm) continue;
      for (const [m, s] of Object.entries(metrics)) {
        if (!bm[m] || TIMING.test(m)) continue;
        compared++;
        const a = bm[m].mean, b = s.mean;
        const rel = Math.abs(b - a) / Math.max(Math.abs(a), 1e-9);
        if ((Math.abs(a) < 1e-9 && Math.abs(b) < 1e-9) || rel <= args.threshold) continue;
        if (Math.abs(b - a) < 0.05) continue; // tiny absolute moves on near-zero metrics
        flagged.push([layer, d, m, a, b, rel]);
      }
    }
  }
  const sameMeta = ['runs', 'seed', 'explore', 'buy', 'treasure'].every((k) => base.meta && base.meta[k] === result.meta[k]);
  console.log(`\nCompare vs ${args.compare}${sameMeta ? '' : ' (NOTE: different runs/seed/explore/buy than the baseline)'}: ` +
    `${compared} means compared, ${flagged.length} moved more than ${(args.threshold * 100).toFixed(0)}%.`);
  if (flagged.length) {
    table('Drift', ['layer', 'depth', 'metric', 'baseline', 'now', 'change'],
      flagged.map(([l, d, m, a, b, rel]) => [l, d, m, f(a, 2), f(b, 2), `${b >= a ? '+' : '-'}${(rel * 100).toFixed(0)}%`]));
  }
}
