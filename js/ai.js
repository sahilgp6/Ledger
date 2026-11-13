// On-device language model ("Ask Ledger"), powered by WebLLM over WebGPU.
// Model weights download once from Hugging Face (official mlc-ai builds) and are stored on the phone.
// The compiled model code (.wasm) is served from this site. No financial data is ever sent anywhere:
// prompts are built and answered entirely on the device.

export const MODELS = [
  { id: 'Qwen2.5-1.5B-Instruct-q4f16_1-MLC', label: 'Qwen 2.5 · 1.5B', size: 'about 1 GB', lib: 'Qwen2-1.5B-Instruct-q4f16_1_cs1k-webgpu.wasm', vram: 1629.75, note: 'Best quality. Recommended.' },
  { id: 'Llama-3.2-1B-Instruct-q4f16_1-MLC', label: 'Llama 3.2 · 1B', size: 'about 700 MB', lib: 'Llama-3.2-1B-Instruct-q4f16_1_cs1k-webgpu.wasm', vram: 879.04, note: 'Smaller and lighter. Use if Qwen is unstable.' },
];
export const modelById = (id) => MODELS.find((m) => m.id === id);

let webllm = null, engine = null, engineModel = null, worker = null, loading = null;

const appConfig = () => ({
  model_list: MODELS.map((m) => ({
    model: `https://huggingface.co/mlc-ai/${m.id}`,
    model_id: m.id,
    model_lib: new URL(`../vendor/models/${m.lib}`, import.meta.url).href,
    vram_required_MB: m.vram,
    low_resource_required: true,
    overrides: { context_window_size: 4096 },
  })),
  cacheBackend: 'cache',
});

async function lib() { if (!webllm) webllm = await import('../vendor/web-llm.js'); return webllm; }

export async function gpuStatus() {
  if (!navigator.gpu) return { ok: false, why: 'This browser has no WebGPU. On iPhone it needs iOS 26 or later.' };
  try {
    const a = await navigator.gpu.requestAdapter();
    if (!a) return { ok: false, why: 'WebGPU is present but no GPU adapter is available.' };
    return { ok: true, maxBuffer: a.limits?.maxBufferSize };
  } catch (e) { return { ok: false, why: 'WebGPU could not start: ' + e.message }; }
}

export async function isDownloaded(id) {
  try { return await (await lib()).hasModelInCache(id, appConfig()); } catch { return false; }
}

export const isLoaded = (id) => !!engine && engineModel === id;
export const busy = () => !!loading;

// Downloads (first time) and loads the model into memory. onProgress({ progress 0..1, text })
export async function load(id, onProgress) {
  if (engine && engineModel === id) return engine;
  if (loading) return loading;
  loading = (async () => {
    await unload();
    const { CreateWebWorkerMLCEngine } = await lib();
    worker = new Worker(new URL('./llm-worker.js', import.meta.url), { type: 'module' });
    engine = await CreateWebWorkerMLCEngine(worker, id, { appConfig: appConfig(), initProgressCallback: (r) => onProgress?.({ progress: r.progress ?? 0, text: r.text || '' }) });
    engineModel = id;
    return engine;
  })();
  try { return await loading; }
  catch (e) { await unload(); throw e; }
  finally { loading = null; }
}

export async function unload() {
  try { await engine?.unload(); } catch { /* ignore */ }
  try { worker?.terminate(); } catch { /* ignore */ }
  engine = null; engineModel = null; worker = null;
}

export async function remove(id) {
  if (engineModel === id) await unload();
  const l = await lib();
  await l.deleteModelAllInfoInCache(id, appConfig());
}

// One JSON answer, constrained by a JSON schema so a small model cannot ramble
export async function askJSON(system, user, schema, maxTokens = 400) {
  if (!engine) throw new Error('Model not loaded');
  const r = await engine.chat.completions.create({
    messages: [{ role: 'system', content: system }, { role: 'user', content: user }],
    temperature: 0, max_tokens: maxTokens,
    response_format: { type: 'json_object', schema: JSON.stringify(schema) },
  });
  const txt = r.choices?.[0]?.message?.content || '{}';
  return JSON.parse(txt);
}

// ---------- Prompts ----------
export const QUERY_INTENTS = ['total_spent', 'total_received', 'list', 'count', 'top_payees', 'top_categories', 'monthly_trend', 'account_balance', 'net_worth', 'unsupported'];

export function querySchema(categoryIds) {
  return {
    type: 'object',
    properties: {
      intent: { type: 'string', enum: QUERY_INTENTS },
      payee: { type: 'string' },
      category: { type: 'string', enum: ['', ...categoryIds] },
      account: { type: 'string' },
      from: { type: 'string' },
      to: { type: 'string' },
    },
    required: ['intent', 'payee', 'category', 'account', 'from', 'to'],
  };
}

export function queryPrompt({ today, categories, accounts }) {
  return `You turn questions about personal finances into a search. You never answer the question yourself and never invent numbers.
Today is ${today}. Currency is Indian rupees. The Indian financial year runs 1 April to 31 March ("this FY" = the one containing today).
Output JSON with:
- intent: one of ${QUERY_INTENTS.join(', ')}. Use "unsupported" if the question is not about the user's transactions, accounts or net worth.
- payee: merchant or person name words to search for, lowercase, or "" if none. Do not put category words here.
- category: one category id from the list, or "" if the question names no category.
- account: words from an account name if the question names an account or card, else "".
- from, to: dates as YYYY-MM-DD for the period asked about. If no period is given, use "" for both.
Categories (id: name): ${categories.map((c) => `${c.id}: ${c.name}`).join('; ')}
Accounts: ${accounts.join('; ') || 'none'}
Examples:
Q: how much did I spend on swiggy since july -> {"intent":"total_spent","payee":"swiggy","category":"","account":"","from":"${today.slice(0, 4)}-07-01","to":"${today}"}
Q: groceries last month -> {"intent":"total_spent","payee":"","category":"groceries","account":"","from":"<first day of last month>","to":"<last day of last month>"}
Q: show my amazon orders -> {"intent":"list","payee":"amazon","category":"","account":"","from":"","to":""}
Q: where does my money go -> {"intent":"top_categories","payee":"","category":"","account":"","from":"","to":""}
Q: what's my net worth -> {"intent":"net_worth","payee":"","category":"","account":"","from":"","to":""}`;
}

export function categorySchema(categoryIds, n) {
  return {
    type: 'object',
    properties: { items: { type: 'array', minItems: n, maxItems: n, items: { type: 'object', properties: { i: { type: 'integer' }, category: { type: 'string', enum: ['unknown', ...categoryIds] } }, required: ['i', 'category'] } } },
    required: ['items'],
  };
}
export function categoryPrompt(categories, examples) {
  return `You categorise Indian bank and card transactions. For each numbered merchant, pick the single best category id, or "unknown" if you genuinely cannot tell. Indian context: UPI payments to people's names are usually personal transfers or small local shops; "ATO" or "auto serv" with a fuel surcharge waiver is a petrol pump.
Categories (id: name): ${categories.map((c) => `${c.id}: ${c.name}`).join('; ')}
${examples.length ? 'How this user has categorised similar merchants before:\n' + examples.map((e) => `- ${e.payee} -> ${e.category}`).join('\n') : ''}`;
}

export const SMS_SCHEMA = {
  type: 'object',
  properties: {
    is_transaction: { type: 'boolean' },
    amount: { type: 'number' },
    direction: { type: 'string', enum: ['debit', 'credit'] },
    last4: { type: 'string' },
    merchant: { type: 'string' },
    date: { type: 'string' },
  },
  required: ['is_transaction', 'amount', 'direction', 'last4', 'merchant', 'date'],
};
export const smsPrompt = (today) => `Extract the transaction from an Indian bank SMS. Today is ${today}. is_transaction is false for OTPs, reminders, declined or upcoming payments. amount in rupees as a number. last4 = last 4 digits of the card or account, or "". merchant = who was paid or who paid, or "". date as YYYY-MM-DD.`;
