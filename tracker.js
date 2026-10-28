/*
 * Stat Tab: popup page logic. A thin view: all state lives in the main SillyTavern tab.
 *
 * Copyright (C) 2026 Stat Tab contributors
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */
import { formatValue, makePreset, makeEntity, makeVar, resolveMacros, exportSchemaFile, parseSchemaFile, EXAMPLE_SCHEMA_ID } from './core.js';

const chan = new BroadcastChannel('stat-tab-v1');
const app = document.getElementById('app');
const S = { data: null, online: false, lastSeen: 0, draft: null, isNew: false, inlineEditing: false, dirty: false, notice: null };
const send = (m) => chan.postMessage(m);

/* Safari does not focus buttons/checkboxes on click, so remember which editor control was last clicked. */
app.addEventListener('click', (e) => {
    const k = e.target.closest?.('[data-k]')?.dataset.k;
    S.clickKey = k ? { k, at: Date.now() } : null;
}, true);

/* ---------- tiny DOM helper ---------- */

function h(tag, props = {}, ...kids) {
    const el = document.createElement(tag);
    for (const [k, v] of Object.entries(props ?? {})) {
        if (v === null || v === undefined || v === false) continue;
        if (k === 'class') el.className = v;
        else if (k === 'value') el.value = v;
        else if (k.startsWith('on') && typeof v === 'function') el.addEventListener(k.slice(2), v);
        else el.setAttribute(k, v === true ? '' : v);
    }
    for (const kid of kids.flat()) {
        if (kid === null || kid === undefined || kid === false) continue;
        el.append(kid instanceof Node ? kid : document.createTextNode(String(kid)));
    }
    return el;
}

function timeAgo(ts) {
    const s = Math.max(0, Math.round((Date.now() - ts) / 1000));
    if (s < 10) return 'just now';
    if (s < 60) return `${s} seconds ago`;
    const m = Math.round(s / 60);
    if (m < 60) return `${m} minute${m === 1 ? '' : 's'} ago`;
    const hr = Math.round(m / 60);
    if (hr < 24) return `${hr} hour${hr === 1 ? '' : 's'} ago`;
    return new Date(ts).toLocaleString();
}

const boundPreset = () => S.data?.presets?.find((p) => p.id === S.data.presetId) ?? null;

/* ---------- connection ---------- */

chan.onmessage = (e) => {
    const m = e.data;
    if (!m || typeof m !== 'object') return;
    const wasOnline = S.online;
    S.lastSeen = Date.now();
    S.online = true;
    if (m.t === 'state') {
        S.data = m;
        render();
    } else if (m.t === 'pong' && !wasOnline) {
        send({ t: 'hello' });
        render();
    }
};

setInterval(() => {
    send({ t: 'ping' });
    if (S.online && Date.now() - S.lastSeen > 9000) {
        S.online = false;
        render();
    }
}, 4000);
setInterval(() => document.getElementById('status')?.replaceChildren(...statusKids()), 15000);
send({ t: 'hello' });

/* ---------- render ---------- */

function render() {
    if (S.inlineEditing) { S.dirty = true; return; }
    if (S.draft) {
        // Rebuild when the main-model setting flips, so the "Keep private" option appears or disappears.
        if (!app.querySelector('.editor') || S.editorInj !== Boolean(S.data?.injection?.on)) renderEditor();
        return;
    }
    renderDashboard();
}

function statusKids() {
    const d = S.data;
    if (!d) return ['Waiting for SillyTavern'];
    if (d.updating) return ['Updating'];
    const kids = [];
    if (S.notice && Date.now() < S.notice.until) kids.push(h('span', { class: S.notice.kind === 'err' ? 'err' : 'ok', role: 'status' }, S.notice.text));
    if (d.error) kids.push(h('span', { class: 'err', role: 'alert' }, d.error));
    else if (d.updatedAt) kids.push(`Updated ${timeAgo(d.updatedAt)}`);
    else if (d.presetId) kids.push('Not updated yet');
    if (d.warnings?.length) kids.push(h('span', { class: 'warn', title: d.warnings.join('\n') }, `${d.warnings.length} part${d.warnings.length === 1 ? '' : 's'} of the last reply ignored`));
    return kids;
}

function header() {
    const d = S.data;
    const preset = boundPreset();
    const busy = Boolean(d?.updating);
    const select = h('select', {
        class: 'btn', 'aria-label': 'Schema for this chat', disabled: !d?.hasChat || !S.online,
        onchange: (e) => send({ t: 'bind', presetId: e.target.value || null }),
    }, h('option', { value: '' }, 'No schema'),
        (d?.presets ?? []).map((p) => h('option', { value: p.id, selected: p.id === d.presetId }, p.name)));

    const fileInput = h('input', { type: 'file', accept: '.json,application/json', multiple: true, hidden: true, id: 'schema-file', onchange: importFiles });
    return h('header', { class: 'bar' },
        h('div', {},
            h('h1', {}, preset?.name ?? 'Stat Tab'),
            h('p', { class: 'sub' },
                d?.hasChat ? h('span', {}, d.chatTitle) : null,
                d?.profile ? h('span', {}, `Model profile: ${d.profile}`) : null,
                h('span', { id: 'status' }, ...statusKids()))),
        h('div', { class: 'actions' },
            select,
            h('button', { class: 'btn primary', disabled: !preset || busy || !S.online, onclick: () => send({ t: 'refresh' }) }, busy ? 'Updating' : 'Update now'),
            h('button', { class: 'btn', disabled: !preset || !S.online, onclick: () => openEditor(false) }, 'Edit schema'),
            h('button', { class: 'btn', disabled: !d?.hasChat || !S.online, onclick: () => openEditor(true) }, 'New schema'),
            fileInput,
            h('button', { class: 'btn', disabled: !S.online, title: 'Add schemas from a .json file', onclick: () => fileInput.click() }, 'Import'),
            h('button', { class: 'btn', disabled: !preset, title: 'Save this schema as a .json file', onclick: exportCurrent }, 'Export'),
            h('button', {
                class: 'btn quiet', disabled: !preset || !S.online, title: 'Set every stat back to its starting value',
                onclick: () => { if (confirm('Reset every stat in this chat to its starting value?')) send({ t: 'reset' }); },
            }, 'Reset stats')));
}

function notify(text, kind = 'ok') {
    S.notice = { text, kind, until: Date.now() + 8000 };
    document.getElementById('status')?.replaceChildren(...statusKids());
    setTimeout(() => document.getElementById('status')?.replaceChildren(...statusKids()), 8100);
}

function exportCurrent() {
    const p = boundPreset();
    if (!p) return;
    const slug = p.name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'schema';
    const url = URL.createObjectURL(new Blob([exportSchemaFile([p])], { type: 'application/json' }));
    const a = h('a', { href: url, download: `${slug}.stattab.json` });
    document.body.append(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
    notify(`Exported "${p.name}".`);
}

const readText = (file) => new Promise((resolve, reject) => {
    const fr = new FileReader();
    fr.onload = () => resolve(String(fr.result));
    fr.onerror = () => reject(fr.error);
    fr.readAsText(file);
});

async function importFiles(e) {
    const files = [...(e.target.files ?? [])];
    e.target.value = '';
    const taken = new Set((S.data?.presets ?? []).map((p) => p.name.toLowerCase()));
    const added = [];
    const failed = [];
    for (const file of files) {
        let res;
        try { res = parseSchemaFile(await readText(file)); } catch { res = { ok: false, error: 'The file could not be read.' }; }
        if (!res.ok) { failed.push(`${file.name}: ${res.error}`); continue; }
        for (const p of res.presets) {
            let name = p.name, n = 2;
            while (taken.has(name.toLowerCase())) name = `${p.name} (${n++})`;
            p.name = name;
            taken.add(name.toLowerCase());
            send({ t: 'save-preset', preset: p });
            added.push(p);
        }
    }
    if (added.length && S.data?.hasChat && !S.data.presetId) send({ t: 'bind', presetId: added.at(-1).id });
    if (failed.length) notify(failed[0] + (failed.length > 1 ? ` (and ${failed.length - 1} more)` : ''), 'err');
    else if (added.length) notify(added.length === 1 ? `Imported "${added[0].name}".` : `Imported ${added.length} schemas.`);
}

function empty(title, body, ...buttons) {
    return h('section', { class: 'empty' }, h('h2', {}, title), h('p', {}, body), h('div', { class: 'actions' }, buttons));
}

function renderDashboard() {
    const d = S.data;
    const preset = boundPreset();
    document.title = preset ? `${preset.name}: Stat Tab` : 'Stat Tab';
    app.replaceChildren(header());
    if (!S.online) {
        app.append(h('div', { class: 'offline', role: 'status' }, 'Not connected to SillyTavern. Keep the main SillyTavern tab open; this page reconnects by itself.'));
    }
    if (!d) return;
    if (!d.enabled) { app.append(empty('Stat Tab is turned off', 'Turn it on in the SillyTavern Extensions panel.')); return; }
    if (!d.hasChat) { app.append(empty('Open a chat', 'Stats appear here once a chat is open in SillyTavern.')); return; }
    if (!preset) {
        const hasExample = d.presets.some((p) => p.id === EXAMPLE_SCHEMA_ID);
        app.append(empty('This chat has no schema', hasExample
            ? 'Try the example to see how stats work, pick one from the list above, or build your own.'
            : 'Pick a schema from the list above, or build one for the stats you want to track.',
        hasExample ? h('button', { class: 'btn primary', onclick: () => send({ t: 'bind', presetId: EXAMPLE_SCHEMA_ID }) }, 'Try the example schema') : null,
        h('button', { class: hasExample ? 'btn' : 'btn primary', onclick: () => openEditor(true) }, 'New schema')));
        return;
    }
    if (!preset.entities.some((e) => e.vars.length)) {
        app.append(empty('This schema has no stats yet', 'Add an entity such as a character or a relationship, then give it stats.',
            h('button', { class: 'btn primary', onclick: () => openEditor(false) }, 'Edit schema')));
        return;
    }

    const ledger = h('div', { class: 'ledger' });
    for (const e of preset.entities) {
        if (!e.vars.length) continue;
        const about = resolveMacros(e.description, d.names);
        ledger.append(h('section', { class: 'entity' },
            h('h2', {}, resolveMacros(e.name, d.names)),
            about ? h('p', { class: 'about' }, about) : null,
            e.vars.map((v) => statRow(e, v))));
    }
    app.append(ledger);
    app.append(injectionPanel());
}

function injectionPanel() {
    const inj = S.data?.injection;
    if (!inj) return '';
    return h('details', { class: 'inject', open: S.injectOpen, ontoggle: (e) => { S.injectOpen = e.target.open; } },
        h('summary', {}, inj.on ? 'What the main model sees' : 'Stats are not being sent to the main model'),
        inj.on
            ? [h('pre', {}, inj.text || 'Nothing to send yet: every stat is unset or private.'), h('p', { class: 'hint' }, inj.where)]
            : h('p', { class: 'hint' }, 'Turn on "Send stats to the main model" in Extensions > Stat Tab to include these stats in each reply\'s prompt.'),
        inj.error ? h('p', { class: 'err', role: 'alert' }, inj.error) : null);
}

function statRow(ent, def) {
    const val = S.data.values?.[ent.id]?.[def.id];
    const prev = S.data.prevValues?.[ent.id]?.[def.id];
    const open = (el) => startEdit(el, ent, def, val);

    if (def.type === 'text') {
        return h('div', { class: 'stat' },
            h('div', { class: 'row' }, h('span', { class: 'label', title: def.description }, resolveMacros(def.name, S.data.names))),
            h('button', { class: 'val text', onclick: (ev) => open(ev.currentTarget), title: 'Click to edit' }, val || '\u2014'));
    }

    let delta = null;
    // No change indicator when there is no earlier real value (e.g. the first fill of an unset stat).
    if (typeof prev === 'number' && typeof val === 'number' && prev !== val) {
        const diff = val - prev;
        const shown = formatValue(def, Math.abs(diff));
        delta = h('span', { class: `delta ${diff > 0 ? 'up' : 'down'}`, title: `Was ${formatValue(def, prev)}` }, (diff > 0 ? '+' : '\u2212') + shown);
    }
    const bar = (def.format === 'bar' || def.format === 'percent') && def.min !== null && def.max !== null && def.max > def.min;
    const pct = bar && typeof val === 'number' ? Math.max(0, Math.min(100, ((val - def.min) / (def.max - def.min)) * 100)) : 0;
    return h('div', { class: 'stat' },
        h('div', { class: 'row' },
            h('span', { class: 'label', title: def.description }, resolveMacros(def.name, S.data.names)),
            h('span', {},
                h('button', { class: 'val', onclick: (ev) => open(ev.currentTarget), title: 'Click to edit' }, formatValue(def, val)),
                bar && typeof val === 'number' ? h('span', { class: 'max' }, ` / ${formatValue(def, def.max)}`) : null,
                delta)),
        bar ? h('div', { class: 'track', role: 'progressbar', 'aria-label': resolveMacros(def.name, S.data.names), 'aria-valuemin': def.min, 'aria-valuemax': def.max, 'aria-valuenow': typeof val === 'number' ? val : undefined },
            h('div', { class: 'fill', style: `width:${pct}%` })) : null);
}

/* ---------- inline value editing ---------- */

function startEdit(btn, ent, def, current) {
    if (S.inlineEditing || !S.online) return;
    const isText = def.type === 'text';
    const isMoney = def.type === 'number' && def.format === 'money';
    const start = current === null || current === undefined ? '' : isText ? String(current) : isMoney ? (current / 100).toFixed(2) : String(current);
    const input = isText
        ? h('textarea', { class: 'inline', rows: 2, 'aria-label': def.name }, start)
        : h('input', { class: 'inline', type: 'text', inputmode: isMoney ? 'decimal' : 'numeric', value: start, 'aria-label': def.name });

    let done = false;
    const finish = (commit) => {
        if (done) return;
        done = true;
        S.inlineEditing = false;
        if (commit) {
            let value = input.value;
            if (isMoney) value = Math.round(parseFloat(String(value).replace(/[^0-9.\-]/g, '')) * 100);
            if (!(isMoney && Number.isNaN(value))) {
                send({ t: 'set-value', entityId: ent.id, varId: def.id, value });
                if (!isText && S.data?.values?.[ent.id]) {
                    const n = Number(value);
                    if (Number.isFinite(n)) S.data.values[ent.id][def.id] = Math.round(n);
                } else if (isText && S.data?.values?.[ent.id]) {
                    S.data.values[ent.id][def.id] = String(value).trim();
                }
            }
        }
        S.dirty = false;
        render();
    };
    input.addEventListener('keydown', (e) => {
        if (e.key === 'Escape') finish(false);
        else if (e.key === 'Enter' && !(isText && e.shiftKey)) { e.preventDefault(); finish(true); }
    });
    input.addEventListener('blur', () => finish(true));

    S.inlineEditing = true;
    btn.replaceWith(input);
    input.focus();
    input.select?.();
}

/* ---------- schema editor ---------- */

function openEditor(isNew) {
    const base = isNew ? makePreset('New schema') : boundPreset();
    if (!base) return;
    S.draft = structuredClone(base);
    S.isNew = isNew;
    S.problems = [];
    renderEditor({ top: true });
}

const asNum = (x) => (x === null || x === undefined || String(x).trim() === '' || !Number.isFinite(Number(x)) ? null : Number(x));

function validate(d) {
    const problems = [];
    if (!d.name.trim()) problems.push('Give the schema a name.');
    const ents = new Set();
    d.entities.forEach((e, i) => {
        const en = e.name.trim().toLowerCase();
        if (!en) problems.push(`Entity ${i + 1} needs a name.`);
        else if (ents.has(en)) problems.push(`Two entities are named "${e.name}".`);
        ents.add(en);
        const names = new Set();
        for (const v of e.vars) {
            const vn = v.name.trim().toLowerCase();
            if (!vn) problems.push(`A stat in "${e.name}" needs a name.`);
            else if (names.has(vn)) problems.push(`"${e.name}" has two stats named "${v.name}".`);
            names.add(vn);
            if (v.type === 'number' && v.format === 'bar' && (asNum(v.min) === null || asNum(v.max) === null)) {
                problems.push(`"${v.name}" is shown as a bar, so it needs both a minimum and a maximum.`);
            }
        }
    });
    return problems;
}

/* Every control gets a stable key so focus survives a rebuild of the editor. */
const dk = (obj, name) => ({ 'data-k': `${obj.id}:${name}` });

function move(arr, i, dir) {
    const j = i + dir;
    if (j < 0 || j >= arr.length) return;
    [arr[i], arr[j]] = [arr[j], arr[i]];
    renderEditor();
}

function field(label, control, cls = '') {
    return h('label', { class: `field ${cls}` }, h('span', {}, label), control);
}

function areaInput(obj, key, props = {}) {
    return h('textarea', { rows: 4, oninput: (e) => { obj[key] = e.target.value; }, ...dk(obj, key), ...props }, obj[key] ?? '');
}

function textInput(obj, key, props = {}) {
    return h('input', { type: 'text', value: obj[key] ?? '', oninput: (e) => { obj[key] = e.target.value; }, ...dk(obj, key), ...props });
}

function numInput(obj, key, props = {}) {
    return h('input', { type: 'number', step: 1, value: obj[key] ?? '', oninput: (e) => { obj[key] = e.target.value === '' ? null : Number(e.target.value); }, ...dk(obj, key), ...props });
}

function checkField(obj, key, text, rebuild = true) {
    return h('label', { class: 'field check wide' },
        h('input', { type: 'checkbox', checked: Boolean(obj[key]), ...dk(obj, key), onchange: (e) => { obj[key] = e.target.checked; if (rebuild) renderEditor(); } }),
        h('span', {}, text));
}

function varEditor(ent, v, i) {
    const isNum = v.type === 'number';
    return h('div', { class: 'var' },
        field('Stat name', textInput(v, 'name'), ''),
        field('Type', h('select', { ...dk(v, 'type'), onchange: (e) => { v.type = e.target.value; if (v.type === 'text') v.initial = ''; else { v.initial = 0; v.format ??= 'plain'; } renderEditor(); } },
            h('option', { value: 'number', selected: isNum }, 'Whole number'),
            h('option', { value: 'text', selected: !isNum }, 'Text'))),
        isNum ? [
            field('Minimum', numInput(v, 'min')),
            field('Maximum', numInput(v, 'max')),
            v.startsUnset ? null : field('Starts at', numInput(v, 'initial')),
            field('Shown as', h('select', { ...dk(v, 'format'), onchange: (e) => {
                v.format = e.target.value;
                if (v.format === 'percent') { v.min = asNum(v.min) ?? 0; v.max = asNum(v.max) ?? 100; v.initial = Math.min(v.max, Math.max(v.min, asNum(v.initial) ?? 0)); }
                renderEditor();
            } },
                h('option', { value: 'plain', selected: v.format === 'plain' }, 'Number'),
                h('option', { value: 'bar', selected: v.format === 'bar' }, 'Number with bar'),
                h('option', { value: 'percent', selected: v.format === 'percent' }, 'Percentage (0 to 100, with bar)'),
                h('option', { value: 'money', selected: v.format === 'money' }, 'Money (stored in cents)'))),
            v.format === 'money' ? field('Currency symbol', textInput(v, 'symbol', { maxlength: 4 })) : null,
        ] : [
            field('Max length (characters)', numInput(v, 'maxLength')),
            v.startsUnset ? null : field('Starts as', textInput(v, 'initial')),
        ],
        field('What it means (the model reads this)', textInput(v, 'description'), 'wide'),
        checkField(v, 'startsUnset', 'Starts unset: shown as a dash until the model fills it in, and told to treat it as a placeholder'),
        // Only relevant while stats are being sent to the main model; the flag itself is kept either way.
        S.data?.injection?.on ? checkField(v, 'hideFromModel', 'Keep private: never include this stat when stats are sent to the main model', false) : null,
        h('div', { class: 'tools' },
            h('button', { class: 'btn quiet', title: 'Move up', 'aria-label': 'Move stat up', ...dk(v, 'up'), onclick: () => move(ent.vars, i, -1) }, 'Up'),
            h('button', { class: 'btn quiet', title: 'Move down', 'aria-label': 'Move stat down', ...dk(v, 'down'), onclick: () => move(ent.vars, i, 1) }, 'Down'),
            h('button', { class: 'btn quiet danger', onclick: () => { ent.vars.splice(i, 1); renderEditor({ focus: `${ent.id}:addstat` }); } }, 'Remove stat')));
}

function entityEditor(d, ent, i) {
    return h('section', { class: 'ent' },
        h('div', { class: 'ent-head' },
            field('Entity name', textInput(ent, 'name')),
            h('button', { class: 'btn quiet', 'aria-label': 'Move entity up', ...dk(ent, 'up'), onclick: () => move(d.entities, i, -1) }, 'Up'),
            h('button', { class: 'btn quiet', 'aria-label': 'Move entity down', ...dk(ent, 'down'), onclick: () => move(d.entities, i, 1) }, 'Down'),
            h('button', { class: 'btn quiet danger', onclick: () => { if (!ent.vars.length || confirm(`Remove "${ent.name}" and its stats?`)) { d.entities.splice(i, 1); renderEditor(); } } }, 'Remove entity')),
        h('div', { style: 'margin-top:0.8rem' }, field('Description (optional, the model reads this)', textInput(ent, 'description'))),
        ent.vars.map((v, j) => varEditor(ent, v, j)),
        h('button', { class: 'btn', ...dk(ent, 'addstat'), onclick: () => { const nv = makeVar('New stat'); ent.vars.push(nv); renderEditor({ focus: `${nv.id}:name` }); } }, 'Add stat'));
}

/**
 * Rebuilds the editor but keeps the page where it was and keeps keyboard focus on the same control.
 * `focus` names a control to focus and scroll into view (used for newly added items).
 */
function renderEditor({ top = false, focus = null } = {}) {
    const d = S.draft;
    const problems = S.problems ?? [];
    S.editorInj = Boolean(S.data?.injection?.on);
    const y = window.scrollY;
    const clicked = S.clickKey && Date.now() - S.clickKey.at < 1000 ? S.clickKey.k : null;
    const keep = clicked ?? document.activeElement?.dataset?.k ?? null;
    S.clickKey = null;
    const addEntity = (name) => () => { const ne = makeEntity(name); d.entities.push(ne); renderEditor({ focus: `${ne.id}:name` }); };
    app.replaceChildren(h('div', { class: 'editor' },
        h('h1', { style: 'font:600 1.9rem var(--serif);margin:0 0 1rem' }, S.isNew ? 'New schema' : 'Edit schema'),
        field('Schema name', textInput(d, 'name', { class: 'name-input' })),
        field('Instructions for the model (optional, never shown on the dashboard)', areaInput(d, 'instructions', { placeholder: 'For example: this is a slow-burn modern drama, so change relationship stats by small amounts.' })),
        h('p', { class: 'hint' }, 'Entity names can use {{user}} and {{char}}, so one schema works across chats. Money is stored as whole cents: tell the model so in the stat description if needed.'),
        d.entities.map((e, i) => entityEditor(d, e, i)),
        h('div', { class: 'actions', style: 'margin-top:1.2rem' },
            h('button', { class: 'btn', onclick: addEntity('New entity') }, 'Add entity'),
            h('button', { class: 'btn', onclick: addEntity('{{user}}') }, 'Add {{user}}'),
            h('button', { class: 'btn', onclick: addEntity('{{char}}') }, 'Add {{char}}')),
        problems.length ? h('ul', { class: 'problems', role: 'alert' }, problems.map((p) => h('li', {}, p))) : null,
        h('div', { class: 'footer' },
            h('button', { class: 'btn primary', onclick: saveDraft }, 'Save schema'),
            h('button', { class: 'btn', onclick: closeEditor }, 'Cancel'),
            h('span', { class: 'spacer' }),
            S.isNew ? null : h('button', { class: 'btn danger', onclick: deleteDraft }, 'Delete schema'))));
    window.scrollTo({ top: top ? 0 : y });
    const want = focus ?? keep;
    if (want) {
        const el = [...app.querySelectorAll('[data-k]')].find((n) => n.dataset.k === want);
        if (el) {
            el.focus({ preventScroll: true });
            if (focus) el.scrollIntoView?.({ block: 'center' });
        }
    }
}

function closeEditor() {
    S.draft = null;
    S.problems = [];
    renderDashboard();
    window.scrollTo({ top: 0 });
}

function saveDraft() {
    const d = S.draft;
    S.problems = validate(d);
    if (S.problems.length) { renderEditor(); app.querySelector('.problems')?.scrollIntoView?.({ block: 'nearest' }); return; }
    send({ t: 'save-preset', preset: d });
    if (S.isNew || S.data?.presetId !== d.id) send({ t: 'bind', presetId: d.id });
    closeEditor();
}

function deleteDraft() {
    if (!confirm(`Delete the schema "${S.draft.name}"? Chats using it will have no schema.`)) return;
    send({ t: 'delete-preset', id: S.draft.id });
    closeEditor();
}

renderDashboard();
