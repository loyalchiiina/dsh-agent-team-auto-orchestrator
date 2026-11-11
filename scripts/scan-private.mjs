#!/usr/bin/env node
/**
 * scan-private.mjs — 发布前脱敏闸门（fail-closed）
 *
 * 挂在 package.json 的 scripts.prepublishOnly 上：`npm publish` 之前自动运行。
 * 扫描对象 = **npm 自己算出来的将打包文件清单**（npm pack --dry-run --json 的
 * files[].path），因此与实际发布会打进包的内容完全一致 —— 不自己实现 glob，
 * 避免与 npm 的 files/.npmignore 语义产生偏差。
 *
 * 设计约束（照用户要求）：
 *   1) 只报不改 —— 扫描器绝不自动修改文件，避免「自动改坏」。
 *   2) BLOCKER 命中 → exit 1，中止发布（警告等于没有）。
 *   3) WARN 只打印，不参与 fail 判定。
 *   4) 宁可误报，不漏报。每条误报都应能被人工一眼判定。
 *   5) 无 BOM、UTF-8、LF。
 *
 * 注意：不要把 scripts/ 加进 package.json 的 files 白名单 —— 本文件正文
 * 含有被扫描关键词的字面量（这正是它的规则表），随包发布会被自己拦下。
 * 脚本末尾有对应自检 WARN。
 */

import { spawnSync } from 'node:child_process'
import { readFileSync, statSync, readdirSync, existsSync } from 'node:fs'
import os from 'node:os'
import { basename, dirname, join, resolve, relative } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const TAG = '[scan-private]'
const BINARY_PROBE = 512
const MAX_LINE_SHOWN = 100
const MAX_WARN_PER_FILE = 3
const MAX_WARN_TOTAL = 40

/* ------------------------------------------------------------------ *
 * 动态「当前用户名」规则（用户 2026-11-09 选 B 方案：候选名并集 + 黑名单只降级裸词）
 * ------------------------------------------------------------------ */

/**
 * 为什么不写死用户名：
 *   写死在规则表里 = 公开仓库正文里躺着本机用户名，一次命中两条红线
 *   （① 脱敏 0 命中；② 任何人 clone 后规则表里都带着别人的环境信息）。
 *   改成运行时从多个来源推导候选用户名，源码里就不再出现任何用户名。
 *
 * 防误伤（2026-11-09 B 方案）：路径 / 压平规则**永远生成**（名字多通用都生成）；
 *   通用名黑名单只决定「裸词规则是 BLOCKER 还是降级 WARN」，**不再整体跳过**
 *   （老代码命中黑名单就 `return [pathRule]`，把裸词规则永久丢掉 = 静默漏拦）。
 */
const MIN_USERNAME_LEN = 3
const GENERIC_USERNAMES = new Set([
  'user', 'users', 'admin', 'root', 'test', 'testing', 'runner',
  'pc', 'windows', 'guest', 'default', 'demo', 'dev', 'developer', 'build', 'ci',
  'node', 'npm', 'docker', 'ubuntu', 'debian', 'linux', 'public', 'home', 'work',
  'name', 'owner', 'master', 'server', 'local', 'system', 'temp', 'tmp', 'me', 'git',
])

/**
 * 候选用户名集合（1.1.3 修复：只信 os.userInfo() 会漏拦）
 *
 * 为什么不能只取一个来源：同一个 Windows 账号在不同 API / 不同进程里会给出
 * 不同形态（SAM 名 vs 显示名、大小写不同、homedir 与 PROFILE 目录名不一致）。
 * 只取一个 → 另一种形态的规则整条不存在 = **静默漏拦**（2026-11-09 事故）。
 * 收集过程不写死任何用户名，源码里依旧 0 命中。
 */
function candidateUsernames() {
  const found = []
  const add = (v) => {
    const s = String(v || '').trim()
    if (!s) return
    const key = s.toLowerCase()
    if (found.some((x) => x.toLowerCase() === key)) return
    found.push(s)
  }
  const fromPath = (p) => {
    const m = String(p || '').match(/[\\/]Users[\\/]+([^\\/]+)/i)
    if (m) add(m[1])
  }

  // ① 系统 API：账号名 + 家目录名（两者可能不一致）
  try { add(os.userInfo().username) } catch { /* 取不到就跳过 */ }
  try { add(basename(os.homedir())) } catch { /* 同上 */ }

  // ② 环境变量
  add(process.env.USERNAME)
  add(process.env.USER)
  fromPath(process.env.USERPROFILE)
  fromPath(process.env.HOME)

  // ③ 真实路径反推：DSH_HOME / 插件根 / 当前工作目录都可能带 C:\Users\<X> 段
  fromPath(process.env.DSH_HOME)
  fromPath(ROOT)
  fromPath(process.cwd())

  return found
}

/** 用户名进正则前必须转义（Windows 用户名允许 . _ - 空格等正则元字符）。 */
function escapeRe(s) {
  return String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

/**
 * 当前用户名规则 —— 每个候选名生成 2~3 条
 *
 * current-username-path    路径段形态，**永远生成**（与黑名单无关）。
 *   老写法 `[A-Za-z]:[\\/]+NAME` 只能拦 `D:\NAME\`，拦不住标准布局
 *   `C:\Users\NAME\...`（盘符后紧跟的是 Users，不是 NAME）——本次漏拦的一半原因。
 *   新写法「分隔符 + NAME + 分隔符/行尾」同时覆盖 C:\NAME\、C:\Users\NAME\、
 *   Users\NAME、/home/NAME/。
 *
 * current-username-mangled 路径压平形态 `C-Users-NAME-...`，**永远生成**。
 *   DSH 会话/工作目录名会把 `C:\Users\NAME\...` 的分隔符换成 `-`，
 *   既没盘符也没斜杠，只能单独一条规则兜。
 *
 * current-username         裸词形态（带词边界），**仅当名字不是通用名时**生成。
 *   通用名（admin/user/…）在英文正文里到处都是，裸词 BLOCKER 会让 CI/docker
 *   账号的包永久红灯 → 黑名单只判裸词，不再整体跳过（老代码 `return [pathRule]` 就是整体跳过）。
 */
function usernameRules() {
  const names = candidateUsernames().filter((n) => n.length >= MIN_USERNAME_LEN)
  if (names.length === 0) {
    console.log(`${TAG} WARN：未取到可用用户名，已跳过 current-username 系列规则（长度 < ${MIN_USERNAME_LEN}）`)
    return []
  }
  const rules = []
  names.forEach((name, i) => {
    const esc = escapeRe(name)
    const idx = i === 0 ? '' : `-${i + 1}`
    rules.push({
      id: `current-username-path${idx}`,
      label: '当前用户名的路径形态',
      re: new RegExp(`[\\\\/]${esc}(?=[\\\\/]|$)`, 'i'),
    })
    rules.push({
      id: `current-username-mangled${idx}`,
      label: '当前用户名的路径压平形态（C-Users-X）',
      re: new RegExp(`Users-${esc}(?=[-._\\s]|$)`, 'i'),
    })
    if (!GENERIC_USERNAMES.has(name.toLowerCase())) {
      rules.push({
        id: `current-username${idx}`,
        label: '当前用户名',
        re: new RegExp(`(?<![A-Za-z0-9_])${esc}(?![A-Za-z0-9_])`, 'i'),
      })
    } else {
      console.log(
        `${TAG} 注意：username 为通用名，裸词规则降级为 WARN（长度 ${name.length}；` +
          `路径/压平规则仍为 BLOCKER，黑名单不再整体跳过）`,
      )
    }
  })
  return rules
}

/**
 * 通用名账号的「裸词」兜底规则 —— 只进 WARN，不进 BLOCKER。
 * 既不放弃线索（发布时打印，人一眼可判），也不让 CI/docker 账号的包永久红灯。
 */
function usernameWarnRules() {
  const rules = []
  candidateUsernames()
    .filter((n) => n.length >= MIN_USERNAME_LEN && GENERIC_USERNAMES.has(n.toLowerCase()))
    .forEach((name, i) => {
      const idx = i === 0 ? '' : `-${i + 1}`
      rules.push({
        id: `current-username-generic${idx}`,
        label: '当前用户名（通用名，仅提示）',
        re: new RegExp(`(?<![A-Za-z0-9_])${escapeRe(name)}(?![A-Za-z0-9_])`, 'i'),
      })
    })
  return rules
}

/* ------------------------------------------------------------------ *
 * 规则表
 * ------------------------------------------------------------------ */

/**
 * BLOCKER：命中即 exit 1。
 * 每行只记第一条命中的规则（同一行不会因为叠加规则而重复计数）。
 * 顺序有意义：越具体的越靠前（win-user-dir 与 current-username-path 这类
 * 用户目录/用户名形态先于通用盘符规则）。
 */
const BLOCKERS = [
  { id: 'win-user-dir', label: 'Windows 用户目录绝对路径', re: /[A-Za-z]:[\\/]+Users[\\/]+/i },
  // 当前用户名（动态推导，源码不含用户名；B 方案：路径/压平永远生成，通用名裸词降级 WARN）
  ...usernameRules(),
  // 盘符路径：宁可误报（注释里写的 D:\ 也算），人工一眼可判
  { id: 'drive-path', label: '本机盘符路径（D:/E:）', re: /\b[D-E]:[\\/]+[A-Za-z0-9_\u4e00-\u9fa5]/i },
  { id: 'apikey', label: 'API key 字样', re: /api[_-]?key/i },
  { id: 'password', label: '口令字样', re: /pass(?:word|wd)/i },
  { id: 'secret', label: 'secret 赋值', re: /secret\s*=/i },
  // Bearer 后面必须跟一段像 token 的串（≥8 位非空白/引号），
  // 这样「Bearer 认证」这类纯术语提及不会误报，真 token 一定命中。
  { id: 'bearer', label: 'Bearer token', re: /\bBearer\s+[^\s"'`]{8,}/i },
  { id: 'github-pat', label: 'GitHub PAT', re: /\bghp_[A-Za-z0-9]{10,}/ },
  { id: 'slack-token', label: 'Slack token', re: /\bxox[baprs]-[A-Za-z0-9-]{8,}/ },
  // sk- 必须词边界 + 后面 ≥16 位，避免误伤 task-board（ta|sk-b|oard）
  { id: 'sk-key', label: 'sk- 风格密钥', re: /\bsk-[A-Za-z0-9]{16,}\b/ },
]

/**
 * WARN：打印但不 fail。
 */
const WARNS = [
  { id: 'token', label: 'token 技术术语', re: /\btokens?\b/i },
  { id: 'owner', label: '仓库归属（公开信息）', re: /loyalchiiina/i },
  ...usernameWarnRules(),
]

/* ------------------------------------------------------------------ *
 * 待发布文件清单
 * ------------------------------------------------------------------ */

/** 从可能混入噪声的输出里抠出 JSON。 */
function extractJson(text) {
  const t = (text || '').trim()
  if (!t) return null
  try {
    return JSON.parse(t)
  } catch {
    /* fallthrough */
  }
  const pairs = [
    ['[', ']'],
    ['{', '}'],
  ]
  for (const [open, close] of pairs) {
    const i = t.indexOf(open)
    const j = t.lastIndexOf(close)
    if (i >= 0 && j > i) {
      try {
        return JSON.parse(t.slice(i, j + 1))
      } catch {
        /* keep trying */
      }
    }
  }
  return null
}

/**
 * 首选：npm pack --dry-run --json。
 * 必须 shell:true —— Windows 上 'npm' 解析到 npm.ps1，直接 spawn 会被
 * PowerShell 执行策略拦住。
 */
function listFromNpmPack() {
  if (process.env.SCAN_PRIVATE_ACTIVE === '1') {
    return { ok: false, reason: '检测到递归调用（SCAN_PRIVATE_ACTIVE=1），跳过 npm' }
  }
  const res = spawnSync('npm', ['pack', '--dry-run', '--json'], {
    cwd: ROOT,
    shell: true,
    encoding: 'utf8',
    maxBuffer: 32 * 1024 * 1024,
    timeout: 120000,
    windowsHide: true,
    env: { ...process.env, SCAN_PRIVATE_ACTIVE: '1' },
  })
  if (res.error) return { ok: false, reason: `spawn 失败：${res.error.message}` }
  if (res.status !== 0) {
    const err = (res.stderr || '').trim().split(/\r?\n/).slice(-3).join(' | ')
    return { ok: false, reason: `npm pack 退出码 ${res.status}${err ? `：${err}` : ''}` }
  }
  const parsed = extractJson(res.stdout)
  const entry = Array.isArray(parsed) ? parsed[0] : parsed
  if (!entry || !Array.isArray(entry.files) || entry.files.length === 0) {
    return { ok: false, reason: 'npm pack 输出无法解析出 files[]' }
  }
  const files = entry.files
    .map((f) => ({ path: String(f.path || '').replace(/\\/g, '/'), size: Number(f.size) || 0 }))
    .filter((f) => f.path)
  if (files.length === 0) return { ok: false, reason: 'npm pack 的 files[] 为空' }
  return { ok: true, mode: 'npm pack --dry-run --json', files }
}

/** glob → RegExp（仅覆盖 files 白名单常见写法）。 */
function globToRe(pattern) {
  let out = '^'
  for (let i = 0; i < pattern.length; i++) {
    const c = pattern[i]
    if (c === '*') {
      if (pattern[i + 1] === '*') {
        if (pattern[i + 2] === '/') {
          out += '(?:.*/)?'
          i += 2
        } else {
          out += '.*'
          i += 1
        }
      } else {
        out += '[^/]*'
      }
    } else if (c === '?') {
      out += '[^/]'
    } else if ('\\^$.|+()[]{}'.includes(c)) {
      out += '\\' + c
    } else {
      out += c
    }
  }
  return new RegExp(out + '$')
}

function walk(dir, acc) {
  let entries
  try {
    entries = readdirSync(dir, { withFileTypes: true })
  } catch {
    return acc
  }
  for (const e of entries) {
    if (e.name === 'node_modules' || e.name === '.git') continue
    const abs = join(dir, e.name)
    if (e.isDirectory()) walk(abs, acc)
    else if (e.isFile()) acc.push(relative(ROOT, abs).replace(/\\/g, '/'))
  }
  return acc
}

/**
 * 降级：npm 不可用时，按 package.json 的 files 白名单 + .npmignore 自己算。
 * npm 语义要点：目录条目包含其下全部文件；package.json / README / LICENSE 恒含。
 */
function listFallback(why) {
  let pkg = {}
  try {
    pkg = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8'))
  } catch (e) {
    return { ok: false, reason: `降级模式读 package.json 失败：${e.message}` }
  }
  const patterns = Array.isArray(pkg.files) ? pkg.files.map(String) : []
  const includes = []
  const excludes = []
  for (const raw of patterns) {
    const p = raw.replace(/\\/g, '/').replace(/^\.\//, '')
    if (p.startsWith('!')) excludes.push(p.slice(1))
    else includes.push(p)
  }
  if (existsSync(join(ROOT, '.npmignore'))) {
    for (const line of readFileSync(join(ROOT, '.npmignore'), 'utf8').split(/\r?\n/)) {
      const p = line.trim().replace(/\\/g, '/')
      if (p && !p.startsWith('#')) excludes.push(p)
    }
  }
  const includeRes = includes.map((p) => {
    const isDirLike = !/[*?]/.test(p)
    return { p, re: globToRe(isDirLike ? `${p}/**` : p), dir: p }
  })
  const excludeRes = excludes.map((p) => ({ p, re: globToRe(p.endsWith('/') ? `${p}**` : p) }))
  const always = ['package.json', 'README.md', 'LICENSE', 'LICENCE']

  const all = walk(ROOT, [])
  const files = []
  for (const rel of all) {
    const base = rel.split('/').pop()
    let keep = always.includes(base) || always.some((a) => base.toLowerCase() === a.toLowerCase())
    if (!keep) {
      keep = includeRes.some(({ re, dir }) => re.test(rel) || rel === dir || rel.startsWith(dir + '/'))
    }
    if (keep && excludeRes.some(({ re }) => re.test(rel))) keep = false
    if (keep) {
      let size = 0
      try {
        size = statSync(join(ROOT, rel)).size
      } catch {
        /* size 仅用于展示 */
      }
      files.push({ path: rel, size })
    }
  }
  if (files.length === 0) return { ok: false, reason: '降级模式未能算出任何文件' }
  return { ok: true, mode: `降级模式（${why}）`, degraded: why, files: files.sort((a, b) => a.path.localeCompare(b.path)) }
}

/* ------------------------------------------------------------------ *
 * 扫描
 * ------------------------------------------------------------------ */

function isBinary(buf) {
  const n = Math.min(buf.length, BINARY_PROBE)
  for (let i = 0; i < n; i++) if (buf[i] === 0) return true
  return false
}

function clip(s, n = MAX_LINE_SHOWN) {
  const t = String(s).replace(/[\u0000-\u001f\u007f]+/g, ' ').trim()
  return t.length > n ? t.slice(0, n) + '…' : t
}

function scanFile(rel) {
  const abs = join(ROOT, rel)
  let buf
  try {
    buf = readFileSync(abs)
  } catch (e) {
    return { rel, readError: e.message, blockers: [], warns: [] }
  }
  if (isBinary(buf)) return { rel, binary: true, blockers: [], warns: [] }
  const text = buf.toString('utf8')
  const lines = text.split(/\r?\n/)
  const blockers = []
  const warns = []
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]
    if (!line) continue
    for (const rule of BLOCKERS) {
      const m = line.match(rule.re)
      if (m) {
        blockers.push({ line: i + 1, id: rule.id, label: rule.label, hit: m[0], text: clip(line) })
        break
      }
    }
    for (const rule of WARNS) {
      const m = line.match(rule.re)
      if (m) {
        warns.push({ line: i + 1, id: rule.id, label: rule.label, hit: m[0], text: clip(line) })
        break
      }
    }
  }
  return { rel, binary: false, bytes: buf.length, blockers, warns }
}

/* ------------------------------------------------------------------ *
 * 主流程
 * ------------------------------------------------------------------ */

function main() {
  const listed = listFromNpmPack()
  let inventory = listed
  if (!listed.ok) {
    console.log(`${TAG} 注意：npm pack 不可用（${listed.reason}），切换到降级模式。`)
    inventory = listFallback(listed.reason)
  }
  if (!inventory.ok) {
    console.log(`${TAG} FAIL：无法确定待发布文件清单（${inventory.reason}）。fail-closed，发布已中止。`)
    process.exit(1)
  }

  const totalBytes = inventory.files.reduce((s, f) => s + (f.size || 0), 0)
  console.log(
    `${TAG} 待发布文件 ${inventory.files.length} 个 / 共 ${totalBytes.toLocaleString('en-US')} B（来源：${inventory.mode}）`,
  )
  if (inventory.degraded) {
    console.log(`${TAG} 降级模式：清单由 files 白名单 + .npmignore 推算，可能与真实打包略有出入，建议修好 npm 后复跑。`)
  }

  const results = inventory.files.map((f) => scanFile(f.path))
  const readErrors = results.filter((r) => r.readError)
  const binaries = results.filter((r) => r.binary)
  const hitFiles = results.filter((r) => r.blockers.length > 0)
  const blockerCount = results.reduce((s, r) => s + r.blockers.length, 0)
  const warnCount = results.reduce((s, r) => s + r.warns.length, 0)

  /* --- BLOCKER --- */
  if (blockerCount > 0) {
    console.log(`${TAG} BLOCKER 命中 ${blockerCount} 处：`)
    for (const r of hitFiles) {
      for (const b of r.blockers) {
        console.log(`  ${r.rel}:${b.line}: ${clip(b.hit, 40)}  [${b.id} ${b.label}]  → ${b.text}`)
      }
    }
  }

  /* --- WARN（独立一段，不进 fail） --- */
  const warnFiles = results.filter((r) => r.warns.length > 0)
  if (warnCount > 0) {
    console.log(`${TAG} WARN ${warnCount} 处（仅提示，不中止发布）：`)
    let shown = 0
    for (const r of warnFiles) {
      let perFile = 0
      for (const w of r.warns) {
        if (shown >= MAX_WARN_TOTAL || perFile >= MAX_WARN_PER_FILE) break
        console.log(`  ${r.rel}:${w.line}: ${clip(w.hit, 40)}  [${w.id}]  → ${w.text}`)
        shown++
        perFile++
      }
      if (perFile < r.warns.length) {
        console.log(`  ${r.rel}: … 另有 ${r.warns.length - perFile} 处同类 WARN`)
      }
    }
  }

  /* --- 读取失败：fail-closed --- */
  if (readErrors.length > 0) {
    console.log(`${TAG} FAIL：${readErrors.length} 个待发布文件读不出来（清单可能过期）：`)
    for (const r of readErrors) console.log(`  ${r.rel}: ${r.readError}`)
    console.log(`${TAG} 发布已中止。`)
    process.exit(1)
  }

  /* --- 扫描器自身入包自检 --- */
  const selfShipped = inventory.files.some((f) => f.path.startsWith('scripts/'))
  if (selfShipped) {
    console.log(
      `${TAG} WARN：scripts/ 出现在发布清单里。本脚本正文含被扫描关键词的字面量（规则表本身），` +
        `下次发布会被自己拦下 —— 建议把 scripts 移出 files 白名单。`,
    )
  }

  const skipped = binaries.length > 0 ? `（跳过二进制 ${binaries.length} 个）` : ''

  /* --- 结论 --- */
  if (blockerCount > 0) {
    console.log(`${TAG} FAIL：${blockerCount} 处必须脱敏，发布已中止。`)
    process.exit(1)
  }
  console.log(`${TAG} PASS：${inventory.files.length} 个文件全部干净${skipped}。`)
  process.exit(0)
}

main()
