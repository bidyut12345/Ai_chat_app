import { Router } from 'express';
import path from 'node:path';
import { getAllSettings, getSetting, setSetting } from '../db.js';
import { listModels, runtimeConfig, REASONING_EFFORTS } from '../services/openai.js';
import { policySnapshot } from '../services/builtin/policy.js';
import { requireAdmin } from '../services/auth.js';

const router = Router();

const EDITABLE_KEYS = [
  'api_base_url',
  'api_key',
  'model',
  'temperature',
  'max_tokens',
  'max_tool_rounds',
  'builtin_shell_timeout',
  'aitemp_root',
  'reasoning_effort',
  'context_window',
  'context_compress_at',
  'context_keep',
  'allow_registration'
];

/** Never leak the full API key to the UI (or in a PUT echo). */
function maskSettings(all) {
  const masked = { ...all };
  delete masked.api_key_masked;
  if (masked.api_key) {
    const k = masked.api_key;
    masked.api_key_masked = k.length > 8 ? `${k.slice(0, 4)}…${k.slice(-4)}` : '••••';
    delete masked.api_key;
  }
  return masked;
}

// GET /api/settings
router.get('/', (req, res) => {
  res.json(maskSettings(getAllSettings()));
});

// GET /api/settings/tool-policy -> defaults applied to a new chat. Each chat
// carries its own copy of these switches (see PATCH /api/conversations/:id).
router.get('/tool-policy', (req, res) => {
  res.json({
    ...policySnapshot(null),
    note: 'Every chat has its own working folder, approval mode and access scope. Change them above the message box.'
  });
});

// PUT /api/settings  { api_base_url, api_key, model, temperature, max_tokens, max_tool_rounds, ... }  (admin)
router.put('/', requireAdmin, (req, res) => {
  const body = req.body || {};
  const changed = [];
  for (const key of EDITABLE_KEYS) {
    if (!(key in body)) continue;
    let value = body[key];
    if (key === 'api_base_url') {
      value = String(value || '').trim().replace(/\/+$/, '');
      if (!value) return res.status(400).json({ error: 'api_base_url cannot be empty' });
      if (!/^https?:\/\//i.test(value)) {
        return res.status(400).json({ error: 'api_base_url must start with http:// or https://' });
      }
      // Tolerate users pasting the full endpoint or omitting /v1.
      if (!/\/v\d/i.test(value) && !/\/chat\/completions$/i.test(value)) {
        value = `${value}/v1`;
      }
    }
    if (key === 'temperature' && value !== '' && Number.isNaN(Number(value))) {
      return res.status(400).json({ error: 'temperature must be a number' });
    }
    if (key === 'builtin_shell_timeout') {
      const n = Number(value);
      if (value === '' || Number.isNaN(n) || n < 1 || n > 3600) {
        return res.status(400).json({ error: 'builtin_shell_timeout must be a number of seconds between 1 and 3600' });
      }
      value = String(Math.round(n));
    }
    if (key === 'aitemp_root') {
      const raw = String(value || '').trim();
      if (raw && !path.isAbsolute(raw)) {
        return res.status(400).json({ error: 'aitemp_root must be an absolute path (e.g. C:\\aitemp)' });
      }
      value = raw;
    }
    if (key === 'reasoning_effort') {
      const v = String(value ?? 'auto').trim().toLowerCase();
      if (!REASONING_EFFORTS.includes(v)) {
        return res.status(400).json({ error: `reasoning_effort must be one of: ${REASONING_EFFORTS.join(', ')}` });
      }
      value = v;
    }
    if (key === 'context_window') {
      const raw = String(value ?? '').trim();
      if (raw) {
        const n = Number(raw);
        if (!Number.isInteger(n) || n < 512) {
          return res.status(400).json({ error: 'context_window must be a whole number of tokens (≥ 512) or blank' });
        }
        value = String(n);
      } else {
        value = '';
      }
    }
    if (key === 'context_compress_at' || key === 'context_keep') {
      const raw = String(value ?? '').trim();
      if (raw) {
        const n = Number(raw);
        if (!Number.isInteger(n) || n < 512) {
          return res.status(400).json({ error: `${key} must be a whole number of tokens (≥ 512) or blank to disable` });
        }
        value = String(n);
      } else {
        value = '';
      }
    }
    if (key === 'allow_registration') {
      const v = value === true || value === 1 ? '1' : value === false || value === 0 ? '0' : String(value ?? '').trim();
      if (v !== '0' && v !== '1') {
        return res.status(400).json({ error: 'allow_registration must be 0 (closed) or 1 (open)' });
      }
      value = v;
    }
    setSetting(key, value);
    changed.push(key);
  }
  res.json({ ok: true, changed, settings: maskSettings(getAllSettings()), tool_policy: policySnapshot() });
});

/** Ping a model server and list its models. Never returns the API key. */
async function pingServer(cfg) {
  const r = await fetch(`${cfg.baseUrl}/models`, {
    headers: cfg.apiKey ? { Authorization: `Bearer ${cfg.apiKey}` } : {},
    signal: AbortSignal.timeout(15000)
  });
  const text = await r.text().catch(() => '');
  let models = [];
  try {
    const j = JSON.parse(text);
    models = (j.data || j.models || []).map((m) => m.id || m.name).filter(Boolean);
  } catch {
    /* not JSON, still a valid ping */
  }
  return { ok: r.ok, status: r.status, baseUrl: cfg.baseUrl, modelCount: models.length, models: models.slice(0, 50) };
}

// GET /api/settings/health -> sidebar "N models online" pill. Any signed-in
// user may check the shared server (the chat cannot work without it), but this
// only reads the stored config: unlike POST /test it accepts no overrides, so
// it cannot be used to make the server probe arbitrary hosts.
router.get('/health', async (req, res) => {
  const cfg = runtimeConfig({});
  try {
    res.json(await pingServer(cfg));
  } catch (e) {
    res.json({ ok: false, baseUrl: cfg.baseUrl, error: e.message });
  }
});

// POST /api/settings/test  -> ping the configured server (optionally with unsaved overrides)  (admin)
router.post('/test', requireAdmin, async (req, res) => {
  const b = req.body || {};
  const cfg = runtimeConfig({
    baseUrl: b.api_base_url ?? b.baseUrl,
    apiKey: b.api_key ?? b.apiKey,
    model: b.model
  });
  try {
    res.json(await pingServer(cfg));
  } catch (e) {
    res.status(200).json({ ok: false, baseUrl: cfg.baseUrl, error: e.message });
  }
});

// GET /api/settings/models -> model ids from the configured server
router.get('/models', async (req, res) => {
  const cfg = runtimeConfig({});
  try {
    const models = await listModels(cfg);
    res.json({ baseUrl: cfg.baseUrl, models, current: getSetting('model') });
  } catch (e) {
    res.status(502).json({ error: e.message, baseUrl: cfg.baseUrl });
  }
});

export default router;
