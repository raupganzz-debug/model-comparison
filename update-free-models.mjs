import { mkdir, readFile, writeFile } from "node:fs/promises"
import { join } from "node:path"
import * as cheerio from "cheerio"

const SOURCE = "https://opencode.ai/docs/zen/"
const OUT_DIR = process.env.OUT_DIR || "."
const JSON_PATH = join(OUT_DIR, "free-models.json")
const MD_PATH = join(OUT_DIR, "FREE_MODELS.md")
const RETRY = [429, 500, 502, 503, 520, 521]
const today = new Date().toISOString().slice(0, 10)
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

const fetchHtml = async (url, key, tries = 3) => {
  const headers = { Authorization: `Basic ${Buffer.from(`${key}:`).toString("base64")}`, "Content-Type": "application/json" }
  for (let i = 1; ; i++) {
    const res = await fetch("https://api.zyte.com/v1/extract", {
      method: "POST",
      headers,
      body: JSON.stringify({ url, httpResponseBody: true }),
    })
    if (res.ok) return Buffer.from((await res.json()).httpResponseBody, "base64").toString("utf8")
    if (i >= tries || !RETRY.includes(res.status)) throw new Error(`Zyte ${res.status}: ${await res.text()}`)
    await sleep(2000 * i)
  }
}

const cells = ($, tr) => $(tr).children("td,th").toArray().map((c) => $(c).text().trim())

const rowsOf = ($, headers) => {
  const table = $("table").toArray().find((t) => {
    const head = cells($, $(t).find("tr").first())
    return headers.every((h) => head.includes(h))
  })
  if (!table) throw new Error(`table not found: ${headers.join(", ")}`)
  return $(table).find("tr").toArray().slice(1).map((tr) => cells($, tr))
}

const parse = (html) => {
  const $ = cheerio.load(html)
  const ids = new Map(rowsOf($, ["Model", "Model ID", "Endpoint"]).map(([name, id, endpoint]) => [name, { id, endpoint: endpoint.replace("https://opencode.ai/zen/v1", "") }]))
  const free = rowsOf($, ["Model", "Input", "Output", "Cached Read"]).filter(([, input, output]) => /^free$/i.test(input) && /^free$/i.test(output))
  const notes = $("#privacy").closest(".sl-heading-wrapper").nextAll("ul").first().find("li").toArray().map((li) => $(li).text().trim())
  if (!free.length) throw new Error("no free models found")
  if (!notes.length) throw new Error("privacy section not found")
  const collected = (name) => notes.some((t) => t.startsWith(`${name}:`) || t.startsWith(`${name} (`))
  return free.map(([name]) => ({ name, id: ids.get(name)?.id ?? null, endpoint: ids.get(name)?.endpoint ?? null, collected: collected(name) }))
}

const keyOf = (m) => m.id ?? m.name

const merge = (found, prev) => {
  const before = new Map(prev.models.map((m) => [keyOf(m), m]))
  const models = found.map((m) => ({ ...m, firstSeen: before.get(keyOf(m))?.firstSeen ?? today }))
  const now = new Set(models.map(keyOf))
  const gone = prev.models.filter((m) => !now.has(keyOf(m))).map(({ name, id }) => ({ name, id, removedAt: today }))
  const removed = [...prev.removed.filter((r) => !now.has(keyOf(r))), ...gone].slice(-30)
  return { models, removed, added: models.filter((m) => !before.has(keyOf(m))), gone }
}

const markdown = ({ models, removed }) => {
  const row = (m) => `| ${m.name} | ${m.id ? `\`opencode/${m.id}\`` : "-"} | ${m.endpoint ? `\`${m.endpoint}\`` : "-"} | ${m.collected ? "Yes" : "No"} | ${m.firstSeen} |`
  const history = removed.length ? ["", "## Recently removed", "", "| Model | Removed |", "| --- | --- |", ...removed.map((r) => `| ${r.name} | ${r.removedAt} |`)] : []
  return [
    "# Free OpenCode Zen Models",
    "",
    `Last change: ${today}. Source: [OpenCode Zen docs](${SOURCE}). A model is listed when both input and output are free on the pricing page.`,
    "",
    "| Model | Config ID | Endpoint | Prompts collected | First seen |",
    "| --- | --- | --- | --- | --- |",
    ...models.map(row),
    "",
    "Free models are offered for a limited time and can be removed without notice. Prompts collected means the docs list the model as an exception to the zero-retention and no-training policy.",
    ...history,
  ].join("\n") + "\n"
}

const main = async () => {
  const key = process.env.ZYTE_API_KEY
  if (!key) throw new Error("ZYTE_API_KEY is not set")
  const prev = await readFile(JSON_PATH, "utf8").then(JSON.parse).catch(() => ({ models: [], removed: [] }))
  const { models, removed, added, gone } = merge(parse(await fetchHtml(SOURCE, key)), prev)
  if (JSON.stringify({ models, removed }) === JSON.stringify({ models: prev.models, removed: prev.removed })) return console.log("no changes")
  await mkdir(OUT_DIR, { recursive: true })
  await writeFile(JSON_PATH, JSON.stringify({ source: SOURCE, updatedAt: today, models, removed }, null, 2) + "\n")
  await writeFile(MD_PATH, markdown({ models, removed }))
  console.log(`total ${models.length} | added: ${added.map((m) => m.name).join(", ") || "-"} | removed: ${gone.map((m) => m.name).join(", ") || "-"}`)
}

main().catch((e) => {
  console.error(e.message)
  process.exit(1)
})
