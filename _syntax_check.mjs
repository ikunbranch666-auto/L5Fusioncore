/**
 * _syntax_check.mjs —— 一条命令做完前端源码的**语法级**自检。
 *
 * 为什么需要它：
 *   ① l5Core.js 里的着色器写在**模板字符串**里（const FRAG = ... 反引号 ...）。
 *      只要在 GLSL 注释里写一个裸反引号，字符串就被截断 -> SyntaxError。
 *      这个坑在本项目已经踩了 4 次（v5.19 / v5.20 / v5.21 / v5.21c），每次都是
 *      "改完没检查 -> 页面白屏 -> 还以为是渲染慢"。
 *   ② **curl http://127.0.0.1:5173/src/x.js 返回 200 不代表能跑** ——
 *      vite 会把源码吐出来（200），语法错误要到浏览器解析时才炸。
 *      实测 v5.21c：curl 200，但 node --check 直接 SyntaxError。
 *      -> 自检必须以 node --check 为准，不能拿 HTTP 状态码当证据。
 *
 * 用法（在 l5-core-showcase/ 下）：
 *   node _syntax_check.mjs
 * 退出码 0 = 全部通过；1 = 有文件语法错误（并打印 node 的原始报错定位）。
 */
import { readdirSync, statSync, copyFileSync, rmSync, mkdirSync, readFileSync } from 'node:fs';
import { join, extname, dirname, basename } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const ROOT = dirname(fileURLToPath(import.meta.url));
const SRC = join(ROOT, 'src');
const TMP = join(ROOT, '_syntax_check_tmp');

function walk(dir, out = []) {
  for (const name of readdirSync(dir)) {
    if (name === 'node_modules') continue;
    const p = join(dir, name);
    if (statSync(p).isDirectory()) walk(p, out);
    else if (['.js', '.mjs'].includes(extname(p))) out.push(p);
  }
  return out;
}

const countBackticks = (f) => {
  let n = 0;
  for (const ch of readFileSync(f, 'utf8')) if (ch === '`') n++;
  return n;
};

/** 以 ESM 方式做 node --check（.js 默认按 CJS 解析，会误报 import 语法） */
function checkOne(file) {
  const tmp = join(TMP, basename(file).replace(/\.js$/, '') + '.mjs');
  copyFileSync(file, tmp);
  const r = spawnSync(process.execPath, ['--check', tmp], { encoding: 'utf8' });
  return { ok: r.status === 0, err: (r.stderr || '').split('\n').slice(0, 6).join('\n') };
}

mkdirSync(TMP, { recursive: true });
const files = walk(SRC).sort();
const rows = [];
let bad = 0;

for (const f of files) {
  const rel = f.slice(ROOT.length + 1).replace(/\\/g, '/');
  const { ok, err } = checkOne(f);
  if (!ok) bad++;
  rows.push({ rel, ok, backticks: countBackticks(f), err });
}

rmSync(TMP, { recursive: true, force: true });

const w = Math.max(...rows.map((r) => r.rel.length));
for (const r of rows) {
  console.log(`${r.ok ? 'OK  ' : 'FAIL'}  ${r.rel.padEnd(w)}  backticks=${r.backticks}`);
  if (!r.ok) console.log(r.err.split('\n').map((l) => '      ' + l).join('\n'));
}

if (bad) {
  console.log(`\n${bad} 个文件语法错误。最常见原因：GLSL 注释里写了裸反引号（会截断模板字符串）。`);
  process.exit(1);
}
console.log(`\n全部 ${rows.length} 个文件语法通过。`);
