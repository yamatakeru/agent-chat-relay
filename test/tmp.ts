import { mkdirSync, mkdtempSync } from "node:fs"
import { join } from "node:path"

/**
 * テストの一時ディレクトリを作る。/tmp は使わず（AGENTS.md）、.local/ の下に作る。
 * RELAY_TEST_TMP があれば、その下に作る。bun run mutation は、終わるときに消す場所に向ける。
 * 変異でテストが途中で止められると、後片付け（afterEach）が動かずに残るため（#98）
 */
export function tempDir(prefix: string): string {
  const base = process.env.RELAY_TEST_TMP || join(import.meta.dir, "../.local")
  mkdirSync(base, { recursive: true })
  return mkdtempSync(join(base, prefix))
}
