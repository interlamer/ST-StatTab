/*
 * Stat Tab: pure logic (schema, state resolution, prompt building, reply parsing).
 * No SillyTavern imports, so it runs in the extension, in the popup, and in Node tests.
 *
 * Copyright (C) 2026 Stat Tab contributors
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

export const KEY = 'stat_tab';

/* ---------- small helpers ---------- */

export function uid(prefix = '') {
    return prefix + Math.random().toString(36).slice(2, 9);
}

const str = (x) => (typeof x === 'string' ? x : x == null ? '' : String(x));
const numOrNull = (x) => {
    if (x === null || x === undefined || String(x).trim() === '') return null;
    const n = Number(x);
    return Number.isFinite(n) ? Math.round(n) : null;
};
const norm = (s) => str(s).trim().toLowerCase();

export function resolveMacros(text, names = {}) {
    return str(text)
        .replace(/\{\{user\}\}/gi, names.user || 'User')
        .replace(/\{\{char\}\}/gi, names.char || 'Character');
}

/* ---------- schema ---------- */

export const FORMATS = ['plain', 'bar', 'percent', 'money'];

export function makePreset(name = 'New schema') {
    return { id: uid('p_'), name, instructions: '', updatedAt: Date.now(), entities: [] };
}
export function makeEntity(name = 'New entity') {
    return { id: uid('e_'), name, description: '', vars: [] };
}
export function makeVar(name = 'New stat') {
    return {
        id: uid('v_'), name, type: 'number', description: '',
        min: 0, max: 100, initial: 50, format: 'bar', symbol: '$', maxLength: null, startsUnset: false, hideFromModel: false,
    };
}

function normalizeVar(v) {
    v = v && typeof v === 'object' ? v : {};
    const out = {
        id: str(v.id) || uid('v_'),
        name: str(v.name).trim() || 'Stat',
        type: v.type === 'text' ? 'text' : 'number',
        description: str(v.description).trim(),
        startsUnset: Boolean(v.startsUnset),
        hideFromModel: Boolean(v.hideFromModel),
    };
    if (out.type === 'number') {
        const format = FORMATS.includes(v.format) ? v.format : 'plain';
        let min = numOrNull(v.min);
        let max = numOrNull(v.max);
        if (format === 'percent') { min ??= 0; max ??= 100; }
        if (min !== null && max !== null && min > max) [min, max] = [max, min];
        out.min = min;
        out.max = max;
        out.format = format === 'bar' && (min === null || max === null) ? 'plain' : format;
        out.symbol = v.symbol === undefined ? '$' : str(v.symbol).slice(0, 4);
        out.maxLength = null;
        const init = numOrNull(v.initial) ?? min ?? 0;
        out.initial = clampInt(init, min, max);
    } else {
        out.min = out.max = null;
        out.format = 'plain';
        out.symbol = '$';
        const ml = numOrNull(v.maxLength);
        out.maxLength = ml && ml > 0 ? ml : null;
        out.initial = str(v.initial).trim();
    }
    return out;
}

function clampInt(n, min, max) {
    let r = Math.round(n);
    if (min !== null && r < min) r = min;
    if (max !== null && r > max) r = max;
    return r;
}

export function normalizePreset(raw) {
    const p = raw && typeof raw === 'object' ? raw : {};
    return {
        id: str(p.id) || uid('p_'),
        name: str(p.name).trim() || 'Untitled schema',
        instructions: str(p.instructions).trim(),
        updatedAt: Date.now(),
        entities: (Array.isArray(p.entities) ? p.entities : []).map((e) => {
            e = e && typeof e === 'object' ? e : {};
            return {
                id: str(e.id) || uid('e_'),
                name: str(e.name).trim() || 'Unnamed',
                description: str(e.description).trim(),
                vars: (Array.isArray(e.vars) ? e.vars : []).map(normalizeVar),
            };
        }),
    };
}

/** Entities with macros in their names resolved ({{user}}, {{char}}). */
export function labelled(preset, names) {
    return (preset?.entities ?? []).map((e) => ({ ...e, label: resolveMacros(e.name, names).trim() }));
}

/* ---------- values ---------- */

export function coerceValue(def, raw) {
    if (raw === null || raw === undefined) return null;
    if (def.type === 'number') {
        if (typeof raw === 'string' && raw.trim() === '') return null;
        const n = typeof raw === 'number' ? raw : Number(String(raw).replace(/[,\s]/g, ''));
        if (!Number.isFinite(n)) return null;
        return clampInt(n, def.min ?? null, def.max ?? null);
    }
    if (typeof raw === 'object') return null;
    let s = String(raw).trim();
    if (def.maxLength && s.length > def.maxLength) s = s.slice(0, def.maxLength);
    return s;
}

/** What a stat holds before anything has been decided: its starting value, or null if it starts unset. */
export function defaultValue(v) {
    return v.startsUnset ? null : v.initial;
}

/** Fill gaps with initial values and drop anything the schema no longer knows. */
export function reconcile(preset, values) {
    const out = {};
    for (const e of preset?.entities ?? []) {
        out[e.id] = {};
        for (const v of e.vars) {
            const raw = values?.[e.id]?.[v.id];
            const c = raw === undefined || raw === null ? null : coerceValue(v, raw);
            out[e.id][v.id] = c === null ? defaultValue(v) : c;
        }
    }
    return out;
}

export function applyChanges(preset, values, changes) {
    const next = reconcile(preset, values);
    let changed = 0;
    for (const [eid, vars] of Object.entries(changes ?? {})) {
        for (const [vid, val] of Object.entries(vars)) {
            if (next[eid] && vid in next[eid] && next[eid][vid] !== val) {
                next[eid][vid] = val;
                changed++;
            }
        }
    }
    return { values: next, changed };
}

export function formatValue(def, value) {
    if (value === null || value === undefined) return '\u2014';
    if (def.type !== 'number') return str(value);
    const n = Number(value) || 0;
    if (def.format === 'percent') return n.toLocaleString('en-US') + '%';
    if (def.format === 'money') {
        const abs = (Math.abs(n) / 100).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
        return (n < 0 ? '\u2212' : '') + (def.symbol ?? '$') + abs;
    }
    return n.toLocaleString('en-US');
}

/* ---------- per-message state (lives on the chat message, per swipe) ---------- */

const swipeOf = (msg) => (Number.isInteger(msg?.swipe_id) ? msg.swipe_id : 0);

/** A state only counts if it was written for the swipe that is currently showing. */
export function readMessageState(msg) {
    if (!msg) return null;
    const sid = swipeOf(msg);
    const candidates = [msg.extra?.[KEY], msg.swipe_info?.[sid]?.extra?.[KEY]];
    for (const c of candidates) {
        if (c && typeof c === 'object' && c.values && (c.swipe ?? 0) === sid) return c;
    }
    return null;
}

export function writeMessageState(msg, state) {
    const sid = swipeOf(msg);
    const stamped = { ...state, swipe: sid };
    if (!msg.extra || typeof msg.extra !== 'object') msg.extra = {};
    msg.extra[KEY] = stamped;
    const info = Array.isArray(msg.swipe_info) ? msg.swipe_info[sid] : null;
    if (info) {
        if (!info.extra || typeof info.extra !== 'object') info.extra = {};
        info.extra[KEY] = stamped;
    }
}

/**
 * Current stats = the newest message state in the chat, else the chat baseline, else defaults.
 * Also returns the state before that (for change indicators) and which message anchors it.
 */
export function resolveState(chat, preset, baseline) {
    let cur = null;
    let prev = null;
    let anchor = -1;
    for (let i = (chat?.length ?? 0) - 1; i >= 0; i--) {
        const s = readMessageState(chat[i]);
        if (!s) continue;
        if (!cur) { cur = s; anchor = i; } else { prev = s; break; }
    }
    const base = baseline?.values;
    return {
        values: reconcile(preset, cur ? cur.values : base),
        prevValues: cur ? reconcile(preset, prev ? prev.values : base) : null,
        anchor,
        at: cur?.at ?? null,
    };
}

/* ---------- prompt ---------- */

const clip = (t, n) => (t.length > n ? t.slice(0, n) + ' [...]' : t);

function describeVar(v, current, names) {
    const desc = v.description ? ' ' + resolveMacros(v.description, names) : '';
    const unset = current === null || current === undefined;
    const now = unset
        ? 'NOT SET (a placeholder, not a real value; you must choose one)'
        : v.type === 'text' ? JSON.stringify(current) : String(current);
    if (v.type === 'text') {
        const lim = v.maxLength ? ` (max ${v.maxLength} characters)` : '';
        return `- ${v.name}: text${lim}.${desc} Current value: ${now}`;
    }
    const range = v.min !== null && v.max !== null ? `from ${v.min} to ${v.max}`
        : v.min !== null ? `at least ${v.min}` : v.max !== null ? `at most ${v.max}` : 'no fixed range';
    const unit = v.format === 'money'
        ? 'integer amount in cents (1/100 of the main currency unit)'
        : v.format === 'percent' ? 'integer percentage (no % sign)' : 'integer';
    return `- ${v.name}: ${unit}, ${range}.${desc} Current value: ${now}`;
}

export const DEFAULT_SYSTEM_PROMPT = 'You are a state-tracking engine for an ongoing roleplay. You never write story text. '
    + 'You read the recent conversation and report how the tracked stats changed. '
    + 'Reply with exactly one <stat-update> block containing a JSON object, and nothing else.';

export const DEFAULT_RULES = [
    '1. Use the exact entity names and stat names listed above.',
    '2. Include only stats whose value changed because of what happened in the conversation. Omit unchanged stats.',
    '3. Numbers are plain integers inside the stated range, with no units and no quotes.',
    '4. Text values are short and describe the present state. Replace the old text; do not append to it.',
    '5. Scale each change to what actually happened. Do not invent events.',
    '6. If nothing changed, reply <stat-update>{}</stat-update>.',
].join('\n');

/**
 * @param {object} p
 * @param {object} p.preset
 * @param {object} p.values            current values (reconciled; null = not set yet)
 * @param {{user:string,char:string}} p.names
 * @param {{name:string,text:string}[]} p.messages  oldest first; the last one is analysed
 * @param {string} [p.card]            character description (optional)
 * @param {string} [p.persona]         user persona description (optional)
 * @param {string} [p.systemPrompt]    replaces the default system prompt when non-empty
 * @param {string} [p.rules]           replaces the default numbered rules when non-empty
 * @param {string} [p.extra]           extra instructions (the schema's own), shown after the rules
 */
export function buildPrompt({ preset, values, names, messages, card = '', persona = '', systemPrompt = '', rules = '', extra = '', maxChars = 3000 }) {
    const ents = labelled(preset, names);
    const stats = ents.map((e) => {
        const head = `### ${e.label}` + (e.description ? `: ${resolveMacros(e.description, names)}` : '');
        return [head, ...e.vars.map((v) => describeVar(v, values?.[e.id]?.[v.id], names))].join('\n');
    }).join('\n\n');

    const unset = ents.flatMap((e) => e.vars.filter((v) => (values?.[e.id]?.[v.id] ?? null) === null).map((v) => `${e.label}: ${v.name}`));
    const convo = messages.map((m) => `${m.name}: ${clip(str(m.text), maxChars)}`).join('\n\n');

    const parts = ['## Tracked stats\n' + stats];
    if (card.trim()) parts.push('## Character card (background only)\n' + clip(card.trim(), 1500));
    if (persona.trim()) parts.push('## User persona (background only)\n' + clip(persona.trim(), 800));
    parts.push('## Recent conversation (analyse the final message)\n' + convo);
    parts.push('## Instructions\n' + resolveMacros((rules.trim() || DEFAULT_RULES), names));
    if (extra.trim()) parts.push('### Additional instructions for this schema\n' + resolveMacros(extra.trim(), names));
    if (unset.length) {
        parts.push('### Stats that are NOT SET\n'
            + 'These stats only hold a placeholder and have no real value yet: ' + unset.join('; ') + '. '
            + 'Include every one of them in your reply with a real value, based on what the conversation and the character card establish. '
            + 'If they give no basis, make the most reasonable assumption. Never treat NOT SET as an actual value and never output it.');
    }
    parts.push('Reply format:\n<stat-update>{"<entity name>": {"<stat name>": <new value>}}</stat-update>');

    return [
        { role: 'system', content: resolveMacros(systemPrompt.trim() || DEFAULT_SYSTEM_PROMPT, names) },
        { role: 'user', content: parts.join('\n\n') },
    ];
}

/* ---------- sending stats to the main model ---------- */

export const DEFAULT_INJECT_TEMPLATE = '[Tracked story stats. Treat these as established facts and keep the writing consistent with them.]\n{{stats}}';

/** Plain-text stat list for the main model. Unset and hidden stats are left out. */
export function renderStatsText({ preset, values, names }) {
    const blocks = [];
    for (const e of labelled(preset, names)) {
        const lines = [];
        for (const v of e.vars) {
            if (v.hideFromModel) continue;
            const val = values?.[e.id]?.[v.id];
            if (val === null || val === undefined || val === '') continue;
            let shown;
            if (v.type === 'text') shown = String(val).replace(/\s+/g, ' ').trim();
            else if (v.format === 'bar' && v.max !== null) shown = `${val}/${v.max}`;
            else shown = formatValue(v, val);
            if (shown) lines.push(`- ${v.name}: ${shown}`);
        }
        if (lines.length) blocks.push(`${e.label}:\n${lines.join('\n')}`);
    }
    return blocks.join('\n\n');
}

/** {{stats}} marks where the list goes; a template without it gets the list appended. */
export function applyInjectionTemplate(template, stats, names) {
    if (!stats) return '';
    const t = resolveMacros(str(template).trim() || DEFAULT_INJECT_TEMPLATE, names);
    return t.includes('{{stats}}') ? t.split('{{stats}}').join(stats) : `${t}\n${stats}`;
}

/* ---------- reply parsing ---------- */

export function extractJson(text) {
    let t = str(text).replace(/<think(?:ing)?>[\s\S]*?<\/think(?:ing)?>/gi, '');
    const open = t.search(/<stat-update>/i);
    if (open >= 0) {
        t = t.slice(open + '<stat-update>'.length);
        const close = t.search(/<\/stat-update>/i);
        if (close >= 0) t = t.slice(0, close);
    }
    t = t.replace(/```(?:json)?/gi, '');
    const start = t.indexOf('{');
    if (start < 0) return null;
    let depth = 0, inStr = false, esc = false;
    for (let i = start; i < t.length; i++) {
        const ch = t[i];
        if (inStr) {
            if (esc) esc = false;
            else if (ch === '\\') esc = true;
            else if (ch === '"') inStr = false;
            continue;
        }
        if (ch === '"') inStr = true;
        else if (ch === '{') depth++;
        else if (ch === '}' && --depth === 0) return t.slice(start, i + 1);
    }
    return null;
}

export function parseUpdate(text, preset, names) {
    const fail = (error) => ({ ok: false, error, changes: {}, warnings: [] });
    const json = extractJson(text);
    if (!json) return fail('The model reply did not contain a JSON object.');

    let data;
    try { data = JSON.parse(json); } catch {
        try { data = JSON.parse(json.replace(/,\s*([}\]])/g, '$1')); } catch {
            return fail('The model reply was not valid JSON.');
        }
    }
    if (!data || typeof data !== 'object' || Array.isArray(data)) return fail('The model reply was not a JSON object.');

    const ents = labelled(preset, names);
    const byLabel = new Map(ents.map((e) => [norm(e.label), e]));
    const changes = {};
    const warnings = [];

    let entries = Object.entries(data);
    // Tolerate a flat reply when the schema has a single entity.
    if (ents.length === 1 && entries.length && entries.every(([k, v]) => !byLabel.has(norm(k)) && typeof v !== 'object')) {
        entries = [[ents[0].label, data]];
    }

    for (const [ek, ev] of entries) {
        const ent = byLabel.get(norm(ek));
        if (!ent) { warnings.push(`Unknown entity "${ek}" was ignored.`); continue; }
        if (!ev || typeof ev !== 'object' || Array.isArray(ev)) { warnings.push(`Entry for "${ek}" was not an object.`); continue; }
        const byVar = new Map(ent.vars.map((v) => [norm(v.name), v]));
        for (const [vk, vv] of Object.entries(ev)) {
            const def = byVar.get(norm(vk));
            if (!def) { warnings.push(`Unknown stat "${vk}" on "${ent.label}" was ignored.`); continue; }
            const c = coerceValue(def, vv);
            if (c === null) { warnings.push(`Value for "${ent.label}: ${def.name}" could not be read.`); continue; }
            (changes[ent.id] ??= {})[def.id] = c;
        }
    }
    return { ok: true, changes, warnings };
}

/* ---------- schema files (import / export) ---------- */

export const FILE_FORMAT = 'stat-tab-schema';
const FILE_VERSION = 1;

/** Serialise schemas for sharing. Ids of the schemas themselves are left out; importing assigns fresh ones. */
export function exportSchemaFile(presets) {
    return JSON.stringify({
        format: FILE_FORMAT,
        version: FILE_VERSION,
        exportedAt: new Date().toISOString(),
        schemas: presets.map((p) => ({ name: p.name, instructions: p.instructions ?? '', entities: p.entities })),
    }, null, 2);
}

/** Read a schema file. Accepts our export format, a bare schema object, or an array of schemas. */
export function parseSchemaFile(text) {
    const fail = (error) => ({ ok: false, error, presets: [] });
    if (typeof text !== 'string' || !text.trim()) return fail('The file is empty.');
    if (text.length > 1_000_000) return fail('The file is over 1 MB, which is too large for a schema.');
    let data;
    try { data = JSON.parse(text); } catch { return fail('The file is not valid JSON.'); }

    let list;
    if (data && data.format === FILE_FORMAT) {
        if (Number(data.version) > FILE_VERSION) return fail('This file was made by a newer version of Stat Tab. Update the extension and try again.');
        list = data.schemas;
    } else if (Array.isArray(data)) list = data;
    else if (data && Array.isArray(data.entities)) list = [data];
    if (!Array.isArray(list)) return fail('This does not look like a Stat Tab schema file.');

    const presets = list
        .filter((x) => x && typeof x === 'object' && Array.isArray(x.entities))
        .slice(0, 50)
        .map((x) => { const p = normalizePreset({ ...x, id: undefined }); p.id = uid('p_'); return p; });
    if (!presets.length) return fail('The file does not contain any schemas.');
    return { ok: true, presets, error: '' };
}
