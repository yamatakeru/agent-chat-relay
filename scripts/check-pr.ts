// PR が統括 issue につながっているかの検査。CI（.github/workflows/pr.yml）で PR ごとに動く。
// 正本は sub-issues の親子関係。PR の本文の Refs・Closes などで指す issue の親が、開いている統括 issue（ラベル tracking）であれば通す。
// issue のない PR は、開いている統括 issue の本文に PR の番号があれば通す
//
//   mise exec -- bun --no-env-file --config=/dev/null scripts/check-pr.ts <PR の番号>

/** このリポジトリへの参照（#N）の番号。別のリポジトリへの参照（owner/repo#N）は拾わない */
export function localRefs(text: string): number[] {
  return [...text.matchAll(/(?<![\w./-])#(\d+)(?!\d)/g)].map((m) => Number(m[1]))
}

/** Refs・Closes・Fixes・Resolves などで始まる行の issue の番号。同じ行の #N をすべて拾う。説明の文の途中の「Refs #N」は数えない */
export function refsOf(body: string): number[] {
  const out = new Set<number>()
  for (const line of body.split("\n")) {
    if (!/^\s*(refs?|close[sd]?|fix(e[sd])?|resolve[sd]?)\b\s*:?\s*#\d/i.test(line)) continue
    for (const n of localRefs(line)) out.add(n)
  }
  return [...out]
}

/** 指した issue の様子。tracking は、その issue 自体が開いている統括 issue か。parentTracking は、親が開いている統括 issue か */
export type Ref = { number: number; tracking: boolean; parentTracking: boolean }

export function linkErrors(pr: number, refs: Ref[], trackingBodies: string[]): string[] {
  if (refs.some((r) => r.tracking || r.parentTracking)) return []
  if (trackingBodies.some((b) => localRefs(b).includes(pr))) return []
  const hint = refs.length === 0
    ? "PR の本文に「Refs #<issue>」を書き、その issue を統括 issue の sub-issue にする"
    : `指した issue（${refs.map((r) => `#${r.number}`).join("、")}）を、統括 issue の sub-issue にする`
  return [
    `PR #${pr} が統括 issue につながっていない。${hint}。issue のない PR は、統括 issue の本文に #${pr} を載せる。統括 issue は gh issue list -l tracking で探す。直したら、この検査を再実行する`,
  ]
}

type Node = { __typename: string; state?: string; labels?: { nodes: { name: string }[] }; parent?: Node | null }
const isTracking = (n: Node | null | undefined) => n?.state === "OPEN" && !!n.labels?.nodes.some((l) => l.name === "tracking")

function gh(args: string[]): string {
  const r = Bun.spawnSync(["gh", ...args], { stderr: "inherit" })
  if (!r.success) throw new Error(`gh ${args[0]} に失敗しました`)
  return r.stdout.toString()
}

if (import.meta.main) {
  const pr = Number(process.argv[2])
  if (!Number.isInteger(pr) || pr <= 0) throw new Error("PR の番号を渡す: mise exec -- bun --no-env-file --config=/dev/null scripts/check-pr.ts <PR の番号>")
  const [owner, name] = (process.env.GITHUB_REPOSITORY ?? gh(["repo", "view", "--json", "nameWithOwner", "-q", ".nameWithOwner"]).trim()).split("/")
  const repo = (body: string) => `query($owner:String!,$name:String!){repository(owner:$owner,name:$name){${body}}}`
  const q = (body: string) => JSON.parse(gh(["api", "graphql", "-f", `query=${repo(body)}`, "-f", `owner=${owner}`, "-f", `name=${name}`])).data.repository
  const issue = "state labels(first:20){nodes{name}}"
  const first = q(`pr:pullRequest(number:${pr}){body} t:issues(labels:["tracking"],states:OPEN,first:100){nodes{body}}`)
  const numbers = refsOf(first.pr.body)
  const found = numbers.length === 0 ? {} : q(numbers.map((n) => `i${n}:issueOrPullRequest(number:${n}){__typename ... on Issue{${issue} parent{${issue}}}}`).join(" "))
  const refs = numbers.map((n) => {
    const node = found[`i${n}`] as Node | null
    return { number: n, tracking: isTracking(node), parentTracking: isTracking(node?.parent) }
  })
  const errors = linkErrors(pr, refs, first.t.nodes.map((n: { body: string }) => n.body))
  for (const e of errors) console.error(e)
  if (errors.length > 0) process.exit(1)
  console.log(`PR #${pr} は統括 issue につながっている`)
}
