/* Suggests descriptions for measures that have none, using the Claude API (Node).
 * Optional: needs the Anthropic SDK (npm install @anthropic-ai/sdk) and credentials in the environment
 * (ANTHROPIC_API_KEY, or a profile from `ant auth login`). Names and DAX of the measures are sent to the API;
 * nothing is written here, the caller decides which suggestions to save. */
'use strict';
const SMO = require('./core.js');
const { loadPath } = require('./loader.js');

const MODEL = 'claude-opus-5-5';
const BATCH = 40;

const TOOL = {
  name: 'save_descriptions',
  description: 'Hand back one description per measure.',
  strict: true,
  input_schema: {
    type: 'object',
    properties: {
      descriptions: {
        type: 'array',
        items: {
          type: 'object',
          properties: { id: { type: 'string' }, description: { type: 'string' } },
          required: ['id', 'description'],
          additionalProperties: false,
        },
      },
    },
    required: ['descriptions'],
    additionalProperties: false,
  },
};

const SYSTEM = [
  'You write descriptions for measures in a Power BI semantic model. Report builders read them in the field list to decide which measure to use.',
  'For each measure write one or two plain sentences that say what the number means in business terms and, where it matters, what is included or excluded (filters, which date is used, the unit).',
  'Describe the meaning, not the DAX: do not name functions. Do not start with the measure name or with "This measure". Do not invent facts the formula does not show; if the purpose cannot be told from the formula and the names, say what it calculates as far as you can tell.',
  'Write in the language of the examples you are given; when there are none, in the language of the measure and table names.',
  'Return the result by calling save_descriptions once, with the id of every measure you were given.',
].join('\n');

function loadSdk() {
  try { const m = require('@anthropic-ai/sdk'); return m.default || m; }
  catch (e) { throw new Error('The Anthropic SDK is not installed. Run "npm install @anthropic-ai/sdk" in the tool folder, then restart the server.'); }
}

/** target/modelRoot as elsewhere; ids: optional list of measure ids. → {suggestions: [{id, table, name, description}], model} */
async function suggestDescriptions(target, modelRoot, ids) {
  const Anthropic = loadSdk();
  const p = SMO.loadProject((await loadPath(target)).files);
  const m = p.models.find(x => x.root === String(modelRoot).replace(/\\/g, '/')) || p.models[0];
  if (!m || m.missing) throw new Error('No model loaded.');
  const a = SMO.analyze(m.model, p.reports);
  const want = ids && ids.length ? new Set(ids) : null;
  const todo = a.list.filter(n => n.kind === 'measure' && !String(n.description || '').trim() && (want ? want.has(n.id) : !n.hidden));
  if (!todo.length) return { suggestions: [], model: MODEL };
  const examples = a.list.filter(n => n.kind === 'measure' && String(n.description || '').trim()).slice(0, 8)
    .map(n => `- [${n.name}] = ${n.expression.replace(/\s+/g, ' ').slice(0, 300)}\n  Description: ${n.description}`);
  const tables = a.list.filter(n => n.type === 'table' && n.description).map(n => `- ${n.name}: ${n.description}`).slice(0, 60);

  const client = new Anthropic();
  const out = [];
  for (let i = 0; i < todo.length; i += BATCH) {
    const part = todo.slice(i, i + BATCH);
    const text = [
      examples.length ? 'Existing descriptions in this model, as examples of language and tone:\n' + examples.join('\n') : '',
      tables.length ? 'Tables:\n' + tables.join('\n') : '',
      'Measures to describe:',
      ...part.map(n => `id: ${n.id}\ntable: ${n.table}\nname: ${n.name}` + (n.formatString ? `\nformat: ${n.formatString}` : '') + `\nformula:\n${n.expression}`),
    ].filter(Boolean).join('\n\n');
    let response;
    try {
      response = await client.beta.messages.create({
        model: MODEL,
        max_tokens: 16000,
        betas: ['server-side-fallback-2026-07-01'],
        fallbacks: 'default',
        system: SYSTEM,
        tools: [TOOL],
        messages: [{ role: 'user', content: text }],
      });
    } catch (error) {
      if (error instanceof Anthropic.AuthenticationError) throw new Error('The Claude API did not accept the credentials. Set ANTHROPIC_API_KEY (or run "ant auth login") and restart the server.');
      if (error instanceof Anthropic.RateLimitError) throw new Error('The Claude API is rate limiting requests. Try again in a moment.');
      if (error instanceof Anthropic.APIError) throw new Error(`The Claude API returned an error (${error.status}): ${error.message}`);
      throw new Error('Could not reach the Claude API: ' + error.message);
    }
    if (response.stop_reason === 'refusal') throw new Error('The model declined this request' + (response.stop_details && response.stop_details.category ? ' (' + response.stop_details.category + ')' : '') + '.');
    if (response.stop_reason === 'max_tokens') throw new Error('The answer was cut off. Select fewer measures and try again.');
    const call = response.content.find(b => b.type === 'tool_use' && b.name === TOOL.name);
    if (!call) throw new Error('The model did not return descriptions.');
    const byId = new Map(part.map(n => [n.id, n]));
    for (const d of (call.input && call.input.descriptions) || []) {
      const n = byId.get(d.id);
      if (n && String(d.description || '').trim()) out.push({ id: n.id, table: n.table, name: n.name, description: String(d.description).trim() });
    }
  }
  return { suggestions: out, model: MODEL };
}

module.exports = { suggestDescriptions };
