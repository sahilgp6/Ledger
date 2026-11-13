// Minimal .xlsx reader: unzips with the browser's built-in DecompressionStream and reads cell values.
// Returns [{ name, rows: [[cell, ...], ...] }]. No external library, nothing leaves the device.

const td = new TextDecoder();
const u16 = (b, o) => b[o] | (b[o + 1] << 8);
const u32 = (b, o) => (b[o] | (b[o + 1] << 8) | (b[o + 2] << 16) | (b[o + 3] << 24)) >>> 0;

async function inflateRaw(bytes) {
  const ds = new DecompressionStream('deflate-raw');
  const stream = new Blob([bytes]).stream().pipeThrough(ds);
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

async function unzip(buf) {
  const b = new Uint8Array(buf);
  let eocd = -1;
  for (let i = b.length - 22; i >= Math.max(0, b.length - 65557); i--) if (u32(b, i) === 0x06054b50) { eocd = i; break; }
  if (eocd < 0) throw new Error('Not an Excel (.xlsx) file');
  const count = u16(b, eocd + 10);
  let p = u32(b, eocd + 16);
  const files = {};
  for (let n = 0; n < count; n++) {
    if (u32(b, p) !== 0x02014b50) break;
    const method = u16(b, p + 10), csize = u32(b, p + 20), nlen = u16(b, p + 28), xlen = u16(b, p + 30), clen = u16(b, p + 32), off = u32(b, p + 42);
    const name = td.decode(b.subarray(p + 46, p + 46 + nlen));
    files[name] = { method, csize, off };
    p += 46 + nlen + xlen + clen;
  }
  const read = async (name) => {
    const f = files[name]; if (!f) return null;
    const lo = f.off, start = lo + 30 + u16(b, lo + 26) + u16(b, lo + 28);
    const data = b.subarray(start, start + f.csize);
    return td.decode(f.method === 0 ? data : await inflateRaw(data));
  };
  return { names: Object.keys(files), read };
}

const ent = (s) => s.replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&#(\d+);/g, (_, n) => String.fromCharCode(+n)).replace(/&amp;/g, '&');
const colNum = (ref) => { const m = ref.match(/^([A-Z]+)/); let n = 0; for (const ch of m[1]) n = n * 26 + ch.charCodeAt(0) - 64; return n - 1; };

export async function readXlsx(buf) {
  const z = await unzip(buf);
  const shared = [];
  const ss = await z.read('xl/sharedStrings.xml');
  if (ss) for (const m of ss.matchAll(/<si>([\s\S]*?)<\/si>/g)) shared.push(ent([...m[1].matchAll(/<t[^>]*>([\s\S]*?)<\/t>/g)].map((t) => t[1]).join('')));
  const wb = await z.read('xl/workbook.xml');
  const rels = await z.read('xl/_rels/workbook.xml.rels') || '';
  const relMap = {}; for (const m of rels.matchAll(/<Relationship[^>]*Id="([^"]+)"[^>]*Target="([^"]+)"/g)) relMap[m[1]] = m[2];
  for (const m of rels.matchAll(/<Relationship[^>]*Target="([^"]+)"[^>]*Id="([^"]+)"/g)) relMap[m[2]] ||= m[1];
  const sheets = [];
  for (const m of (wb || '').matchAll(/<sheet\b[^>]*?name="([^"]+)"[^>]*?r:id="([^"]+)"/g)) {
    let target = relMap[m[2]] || ''; target = target.replace(/^\/?xl\//, '').replace(/^\//, '');
    const xml = await z.read('xl/' + target); if (!xml) continue;
    const rows = [];
    for (const r of xml.matchAll(/<row\b[^>]*>([\s\S]*?)<\/row>/g)) {
      const row = [];
      for (const c of r[1].matchAll(/<c\b([^>]*?)(?:\/>|>([\s\S]*?)<\/c>)/g)) {
        const attrs = c[1], inner = c[2] || '';
        const ref = (attrs.match(/\br="([A-Z]+\d+)"/) || [])[1];
        const t = (attrs.match(/\bt="([^"]+)"/) || [])[1];
        const v = (inner.match(/<v>([\s\S]*?)<\/v>/) || [])[1];
        let val = null;
        if (t === 's') val = shared[+v] ?? '';
        else if (t === 'inlineStr') val = ent([...inner.matchAll(/<t[^>]*>([\s\S]*?)<\/t>/g)].map((x) => x[1]).join(''));
        else if (t === 'str' || t === 'e') val = v != null ? ent(v) : '';
        else if (t === 'b') val = v === '1';
        else if (v != null) val = Number(v);
        row[ref ? colNum(ref) : row.length] = val;
      }
      rows.push(row);
    }
    sheets.push({ name: ent(m[1]), rows });
  }
  return sheets;
}
