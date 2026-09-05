#!/usr/bin/env node
// 配当CSVの取り込み・重複排除・計画線との突合
//
//   node scripts/import-dividends.mjs
//
// data/dividends/raw/<年>/<証券会社>_<日付>.csv を全部読み、
// 正規化して data/dividends/dividends.csv に書き出す。
// 同じ配当が複数のCSVに現れても1件に統合される。

import fs from 'node:fs';
import path from 'node:path';

const RAW_DIR = 'data/dividends/raw';
const OUT = 'data/dividends/dividends.csv';

// FIRE_Strategy.md 第9.7節の計画線（税引前 / 手取り）
// 32歳=2026年。以降1歳ずつ。
const PLAN = {
  2026: [770183, 613721], 2027: [770183, 613720], 2028: [875931, 697986],
  2029: [984835, 784766], 2030: [1096989, 874136], 2031: [1212492, 966174],
  2032: [1331442, 1060959], 2033: [1453943, 1158574], 2034: [1580102, 1259104],
};

// 証券会社ごとの列マッピング。
// key   = ファイル名の先頭（rakuten_2026.csv なら "rakuten"）
// header= そのCSVの見出し行に必ず含まれる文字列（形式の検証用）
// cols  = 正規化後の項目 → CSVの列名
const BROKERS = {
  rakuten: {
    label: '楽天証券',
    header: '入金日',
    cols: { date: '入金日', account: '口座', code: '銘柄コード', name: '銘柄',
            gross: '配当・分配金合計（税引前）[円/現地通貨]',
            tax: '税額合計[円/現地通貨]', net: '受取金額[円/現地通貨]' },
  },
  // ▼ 野村證券・SBI証券は最初のCSVを入手したら列名を埋める。
  //    見出し行を確認して cols の右辺を実際の列名に合わせるだけでよい。
  nomura: {
    label: '野村證券', header: null,
    cols: { date: null, account: null, code: null, name: null, gross: null, tax: null, net: null },
  },
  sbi: {
    label: 'SBI証券', header: null,
    cols: { date: null, account: null, code: null, name: null, gross: null, tax: null, net: null },
  },
};

const num = (s) => Number(String(s ?? '').replace(/[",\s円]/g, '')) || 0;
const yen = (n) => Math.round(n).toLocaleString('ja-JP');

/** ダブルクォート対応の最小CSVパーサ */
function parseCsv(text) {
  const rows = [];
  let row = [], cell = '', q = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (q) {
      if (c === '"' && text[i + 1] === '"') { cell += '"'; i++; }
      else if (c === '"') q = false;
      else cell += c;
    } else if (c === '"') q = true;
    else if (c === ',') { row.push(cell); cell = ''; }
    else if (c === '\n') { row.push(cell); rows.push(row); row = []; cell = ''; }
    else if (c !== '\r') cell += c;
  }
  if (cell || row.length) { row.push(cell); rows.push(row); }
  return rows.filter((r) => r.some((v) => v.trim() !== ''));
}

/** 日付を YYYY-MM-DD に揃える（2026/09/03 も 2026-09-03 も受ける） */
function normDate(s) {
  const m = String(s).match(/(\d{4})\D(\d{1,2})\D(\d{1,2})/);
  if (!m) return null;
  return `${m[1]}-${m[2].padStart(2, '0')}-${m[3].padStart(2, '0')}`;
}

function collectFiles(dir) {
  const out = [];
  if (!fs.existsSync(dir)) return out;
  for (const y of fs.readdirSync(dir)) {
    const yd = path.join(dir, y);
    if (!fs.statSync(yd).isDirectory()) continue;
    for (const f of fs.readdirSync(yd)) if (f.toLowerCase().endsWith('.csv')) out.push(path.join(yd, f));
  }
  return out.sort();
}

const records = new Map();  // 重複排除キー → レコード
const skipped = [];
let dupes = 0;

for (const file of collectFiles(RAW_DIR)) {
  const base = path.basename(file);
  const key = base.split('_')[0].toLowerCase();
  const b = BROKERS[key];
  if (!b) { skipped.push(`${base}: 証券会社を判別できない（ファイル名の先頭を ${Object.keys(BROKERS).join('/')} のいずれかにする）`); continue; }
  if (!b.header) { skipped.push(`${base}: ${b.label} の列マッピングが未設定（scripts/import-dividends.mjs の BROKERS を埋める）`); continue; }

  const text = fs.readFileSync(file, 'utf8').replace(/^﻿/, '');
  const rows = parseCsv(text);
  if (!rows.length) { skipped.push(`${base}: 空`); continue; }

  const head = rows[0].map((h) => h.trim());
  if (!head.some((h) => h.includes(b.header))) { skipped.push(`${base}: 見出しが ${b.label} の形式と違う`); continue; }

  const idx = {};
  for (const [k, col] of Object.entries(b.cols)) idx[k] = head.findIndex((h) => h === col);
  const missing = Object.entries(idx).filter(([, v]) => v < 0).map(([k]) => b.cols[k]);
  if (missing.length) { skipped.push(`${base}: 列が見つからない → ${missing.join(', ')}`); continue; }

  for (const r of rows.slice(1)) {
    const date = normDate(r[idx.date]);
    if (!date) continue;
    const rec = {
      date, broker: b.label,
      account: (r[idx.account] || '').trim(),
      code: (r[idx.code] || '').trim(),
      name: (r[idx.name] || '').trim(),
      gross: num(r[idx.gross]), tax: num(r[idx.tax]), net: num(r[idx.net]),
    };
    // 重複排除キー: 同じ日・同じ証券会社・同じ銘柄・同じ口座・同じ金額なら同一の配当とみなす
    const k = [rec.date, rec.broker, rec.code || rec.name, rec.account, rec.net].join('|');
    if (records.has(k)) { dupes++; continue; }
    records.set(k, rec);
  }
}

const all = [...records.values()].sort((a, b) => (a.date < b.date ? 1 : a.date > b.date ? -1 : 0));

// ---- 出力 ----
const header = '入金日,証券会社,口座区分,銘柄コード,銘柄,税引前,税額,受取金額';
const body = all.map((r) => [r.date, r.broker, r.account, r.code, `"${r.name.replace(/"/g, '""')}"`, r.gross, r.tax, r.net].join(','));
fs.writeFileSync(OUT, '﻿' + [header, ...body].join('\n') + '\n');

// ---- レポート ----
console.log(`\n取り込み ${all.length}件 / 重複除外 ${dupes}件 → ${OUT}`);
if (skipped.length) { console.log('\n⚠️ スキップ:'); for (const s of skipped) console.log('  ' + s); }

const byYear = {};
for (const r of all) {
  const y = r.date.slice(0, 4);
  (byYear[y] ??= { gross: 0, tax: 0, net: 0, n: 0, brokers: new Set(), last: '' });
  byYear[y].gross += r.gross; byYear[y].tax += r.tax; byYear[y].net += r.net;
  byYear[y].n++; byYear[y].brokers.add(r.broker);
  if (r.date > byYear[y].last) byYear[y].last = r.date;
}

console.log('\n=== 年別の配当実績 ===');
console.log('  年    件数  税引前        税額      受取金額     証券会社');
for (const y of Object.keys(byYear).sort()) {
  const v = byYear[y];
  console.log(`  ${y}  ${String(v.n).padStart(4)}  ${yen(v.gross).padStart(10)}  ${yen(v.tax).padStart(9)}  ${yen(v.net).padStart(10)}   ${[...v.brokers].join('・')}`);
}

console.log('\n=== 計画線との突合（FIRE_Strategy.md 第9.7節）===');
const thisYear = new Date().getFullYear();
for (const y of Object.keys(byYear).sort()) {
  const plan = PLAN[y];
  if (!plan) { console.log(`  ${y}: 計画線なし`); continue; }
  const v = byYear[y];
  const partial = Number(y) >= thisYear;         // 進行中の年は年間実績にならない
  const pct = (v.net / plan[1]) * 100;
  const diff = v.net - plan[1];
  let mark = '';
  if (partial) mark = `（${v.last} 時点・進行中）`;
  else if (pct >= 95) mark = '✅ 計画線どおり';
  else if (pct >= 85) mark = '🟡 −5〜15%。翌年の高配当配分を見直す';
  else mark = '🔴 −15%超。第14.2節に従いFIRE時期を再計算する';
  console.log(`  ${y}  実績(手取り) ${yen(v.net).padStart(10)} / 計画 ${yen(plan[1]).padStart(10)}  達成率 ${pct.toFixed(1)}%  ${mark}`);
  if (!partial) console.log(`        差 ${diff >= 0 ? '+' : ''}${yen(diff)}円`);
}
console.log('');
