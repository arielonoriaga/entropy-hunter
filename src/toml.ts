// ponytail: minimal flat TOML (sections + string/number/bool keys) — all our
// config needs. Swap for a real parser if config ever grows nesting/arrays.
export function parseToml(src: string): Record<string, Record<string, string | number | boolean>> {
  const out: Record<string, Record<string, string | number | boolean>> = {};
  let section = "";
  for (const raw of src.split("\n")) {
    const line = raw.replace(/#.*$/, "").trim();
    if (!line) continue;
    const sec = line.match(/^\[([^\]]+)\]$/);
    if (sec) {
      section = sec[1].trim();
      out[section] ??= {};
      continue;
    }
    const kv = line.match(/^([\w.-]+)\s*=\s*(.+)$/);
    if (!kv) continue;
    const [, key, rawVal] = kv;
    let val: string | number | boolean;
    if (rawVal === "true" || rawVal === "false") val = rawVal === "true";
    else if (/^-?\d+(\.\d+)?$/.test(rawVal)) val = Number(rawVal);
    else val = rawVal.replace(/^["']|["']$/g, "");
    (out[section] ??= {})[key] = val;
  }
  return out;
}

export function toToml(obj: Record<string, Record<string, string | number | boolean>>): string {
  return Object.entries(obj)
    .map(
      ([sec, kvs]) =>
        `[${sec}]\n` +
        Object.entries(kvs)
          .map(([k, v]) => `${k} = ${typeof v === "string" ? `"${v}"` : v}`)
          .join("\n"),
    )
    .join("\n\n") + "\n";
}
