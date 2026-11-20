// 固定した pi-acp ソースと上流の lock から、配布用のアダプターを再生成する。
import assert from "node:assert/strict"
import { spawnSync } from "node:child_process"
import { createHash } from "node:crypto"
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { isBuiltin } from "node:module"
import { join } from "node:path"
import { fileURLToPath } from "node:url"

const commit = "b0581c9c1d675e634234674484247008b03d69b4"
const sha256 = "5e1c4af86e3d07c743fb8cd9e72bfc2aa10f9c5110a0cb822bff9225b4f07695"
const root = fileURLToPath(new URL("../", import.meta.url))
const local = join(root, ".local")
const vendor = join(root, "src/vendor/pi")
const args = process.argv.slice(2)
const check = args[0] === "--check"
assert(args.length === Number(check), "引数は --check のみ指定できます")
assert.equal(process.version, "v24.22.3")
assert.equal(spawnSync("npm", ["--version"], { encoding: "utf8" }).stdout?.trim(), "11.19.1")
mkdirSync(local, { recursive: true })
const scratch = mkdtempSync(join(local, "pi-build-"))
const source = join(scratch, "source")
const archive = join(scratch, "pi-acp.tar.gz")
mkdirSync(source)

function run(command, args, input) {
  const result = spawnSync(command, args, {
    cwd: source,
    env: {
      PATH: process.env.PATH,
      HOME: scratch,
      TMPDIR: scratch,
      npm_config_cache: join(local, "pi-npm-cache"),
    },
    stdio: [input === undefined ? "ignore" : "pipe", "inherit", "inherit"],
    input,
  })
  if (result.error) throw result.error
  assert.equal(result.status, 0, `${command} ${args.join(" ")} に失敗しました`)
}

try {
  run("curl", ["-qfsSL", `https://codeload.github.com/svkozak/pi-acp/tar.gz/${commit}`, "-o", archive])
  assert.equal(createHash("sha256").update(readFileSync(archive)).digest("hex"), sha256)
  run("tar", ["-xzf", archive, "--strip-components=1"])
  run("patch", ["-p1"], readFileSync(join(root, "third_party/pi-acp/managed.patch")))
  run("npm", ["ci", "--ignore-scripts", "--no-audit", "--no-fund"])
  run("npm", ["run", "typecheck"])
  run("npm", ["run", "build"])

  const js = readFileSync(join(source, "dist/index.js"), "utf8")
  const imports = /(?<=from ")[^"\n]+(?=")/g
  assert.deepEqual([...new Set([...js.matchAll(imports)].map(m => m[0]).filter(s => !isBuiltin(s)))].sort((a, b) => a.localeCompare(b)), [
    "@agentclientprotocol/sdk", "cross-spawn",
  ])
  const adapter = js.replace(/^#![^\n]+\n/, "")
    .replaceAll('from "@agentclientprotocol/sdk"', 'from "pi-acp-protocol-sdk"')
    .replace(/\n\/\/# sourceMappingURL=[^\n]+\n?$/, "\n")
  const { name, version, type, license } = JSON.parse(readFileSync(join(source, "package.json"), "utf8"))
  assert.equal(version, "0.0.34")
  const files = {
    "adapter.js": "// 生成物。更新手順は docs/pi-packaging.md を参照。\n" + adapter,
    "package.json": JSON.stringify({ name, version, type, license, private: true }, null, 2) + "\n",
    "pi-acp-LICENSE": readFileSync(join(source, "LICENSE"), "utf8"),
  }
  for (const [name, text] of Object.entries(files)) {
    const file = join(vendor, name)
    if (check) assert.equal(createHash("sha256").update(readFileSync(file)).digest("hex"), createHash("sha256").update(text).digest("hex"), `${file} が再生成結果と一致しません`)
    else writeFileSync(file, text)
  }
} finally {
  rmSync(scratch, { recursive: true, force: true })
}
