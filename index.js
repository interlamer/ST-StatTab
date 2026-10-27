/*
 * Stat Tab: SillyTavern extension (main-tab engine)
 *
 * Tracks user-defined stats per entity, updates them with a Connection Manager
 * profile, and mirrors them to a separate browser tab over a BroadcastChannel.
 *
 * Copyright (C) 2026 Stat Tab contributors
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */
import {
    KEY, normalizePreset, resolveState, buildPrompt, parseUpdate, applyChanges,
    coerceValue, writeMessageState, labelled, defaultValue, DEFAULT_SYSTEM_PROMPT, DEFAULT_RULES,
    DEFAULT_INJECT_TEMPLATE, renderStatsText, applyInjectionTemplate,
} from './core.js';

const MODULE = 'stat_tab';
const CHANNEL = 'stat-tab-v1';
const DEFAULTS = {
    enabled: true,
    profileId: '',          // '' = whichever Connection Manager profile is selected
    defaultPresetId: '',    // schema auto-bound to chats that have never had one
    autoUpdate: true,
    contextMessages: 6,
    maxTokens: 800,
    timeoutSeconds: 120,    // give up on a model call after this long
    includeCard: true,
    topBarButton: true,     // icon in SillyTavern's top bar
    systemPrompt: '',       // '' = built-in default
    rules: '',              // '' = built-in default
    injectEnabled: false,   // also send the stats to the main model
    injectPosition: 'chat', // 'before' | 'prompt' | 'chat'
    injectDepth: 1,         // in-chat only; 0 = after the last message
    injectRole: 'system',   // 'system' | 'user' | 'assistant'
    injectTemplate: '',     // '' = built-in default
    debug: false,
    presets: [],
};

const stCtx = () => globalThis.SillyTavern.getContext();
const log = (...a) => { if (getSettings().debug) console.debug('[StatTab]', ...a); };

/* ---------- settings & chat binding ---------- */

function getSettings() {
    const { extensionSettings } = stCtx();
    if (!extensionSettings[MODULE]) extensionSettings[MODULE] = structuredClone(DEFAULTS);
    const s = extensionSettings[MODULE];
    for (const k of Object.keys(DEFAULTS)) if (!(k in s)) s[k] = structuredClone(DEFAULTS[k]);
    return s;
}
const saveSettings = () => stCtx().saveSettingsDebounced?.();

function chatKey(c = stCtx()) {
    return c.getCurrentChatId?.() ?? c.chatId ?? null;
}

/** Never cache chatMetadata: ST replaces the object on every chat switch. */
function binding(c = stCtx()) {
    const md = c.chatMetadata;
    return md && md[KEY] ? md[KEY] : null;
}

function currentPreset(c = stCtx()) {
    const b = binding(c);
    if (!b?.presetId) return null;
    return getSettings().presets.find((p) => p.id === b.presetId) ?? null;
}

function names(c = stCtx()) {
    return { user: c.name1 || 'User', char: c.name2 || 'Character' };
}

/** Chats that have never had a schema get the default one (in memory; saved with the next chat save). */
function autoBindIfNew(c = stCtx()) {
    if (!chatKey(c) || !c.chatMetadata || c.chatMetadata[KEY]) return;
    const s = getSettings();
    const def = s.presets.find((p) => p.id === s.defaultPresetId);
    if (def) c.chatMetadata[KEY] = { presetId: def.id, baseline: null };
}

/* ---------- connection manager ---------- */

let _sharedPromise = null;
async function getConnectionService() {
    const fromCtx = stCtx().ConnectionManagerRequestService;
    if (fromCtx) return fromCtx;
    _sharedPromise ??= import('../../shared.js').catch((e) => { _sharedPromise = null; throw e; });
    const mod = await _sharedPromise;
    return mod.ConnectionManagerRequestService ?? null;
}

function listProfiles() {
    const cm = stCtx().extensionSettings?.connectionManager;
    return (cm?.profiles ?? []).map((p) => ({ id: p.id, name: p.name }));
}

function activeProfile() {
    const s = getSettings();
    const cm = stCtx().extensionSettings?.connectionManager;
    const id = s.profileId || cm?.selectedProfile || '';
    const p = (cm?.profiles ?? []).find((x) => x.id === id);
    return p ? { id: p.id, name: p.name } : null;
}

async function callModel(messages) {
    const s = getSettings();
    const profile = activeProfile();
    if (!profile) throw new Error('No connection profile is available. Create one in the Connection Manager, or pick one in the Stat Tab settings.');
    const service = await getConnectionService();
    if (!service) throw new Error('The Connection Manager extension is not available. Enable it in Extensions > Manage extensions.');

    const ctl = new AbortController();
    const timer = setTimeout(() => ctl.abort(), s.timeoutSeconds * 1000);
    try {
        const res = await service.sendRequest(profile.id, messages, s.maxTokens, { stream: false, signal: ctl.signal });
        const text = typeof res === 'string' ? res : (res?.content ?? '');
        if (!String(text).trim()) throw new Error('The model returned an empty reply. If the profile uses a reasoning model, raise the max tokens or turn reasoning off.');
        return String(text);
    } catch (e) {
        if (ctl.signal.aborted) throw new Error(`The model did not answer within ${s.timeoutSeconds} seconds. You can raise the time limit in the Stat Tab settings.`);
        throw e;
    } finally {
        clearTimeout(timer);
    }
}

/* ---------- update pipeline ---------- */

let inFlight = false;
let lastError = '';
let lastWarnings = [];

const setError = (msg) => { lastError = msg; if (msg) console.warn('[StatTab]', msg); push(); };

function lastMessageIndex(chat) {
    for (let i = chat.length - 1; i >= 0; i--) if (!chat[i].is_system) return i;
    return -1;
}

async function saveChatNow(c = stCtx()) {
    const save = c.saveChatConditional ?? c.saveChat;
    if (save) await save();
}

export async function runUpdate({ anchorIndex } = {}) {
    const c = stCtx();
    const s = getSettings();
    const preset = currentPreset(c);
    if (!s.enabled) return;
    if (!preset || !preset.entities.some((e) => e.vars.length)) {
        setError('Pick or create a schema with at least one stat first.');
        return;
    }
    if (inFlight) return;

    const chat = c.chat;
    const idx = Number.isInteger(anchorIndex) ? anchorIndex : lastMessageIndex(chat);
    const msg = chat[idx];
    if (!msg) { setError('There is no message to analyse yet.'); return; }

    const stamp = { key: chatKey(c), swipe: msg.swipe_id ?? 0, text: msg.mes };
    inFlight = true;
    lastError = '';
    push();
    try {
        const nm = names(c);
        const before = resolveState(chat.slice(0, idx), preset, binding(c));
        const window_ = chat.slice(Math.max(0, idx - s.contextMessages + 1), idx + 1).filter((m) => !m.is_system);
        const char = !c.groupId && c.characters?.[c.characterId];
        const messages = buildPrompt({
            preset, values: before.values, names: nm,
            messages: window_.map((m) => ({ name: m.name || (m.is_user ? nm.user : nm.char), text: m.mes })),
            card: s.includeCard && char ? char.description || '' : '',
            persona: s.includeCard ? c.powerUserSettings?.persona_description || '' : '',
            systemPrompt: s.systemPrompt, rules: s.rules, extra: preset.instructions || '',
        });
        log('prompt', messages);

        const reply = await callModel(messages);
        log('reply', reply);

        // The chat may have changed while we waited.
        const c2 = stCtx();
        const cur = c2.chat?.[idx];
        if (chatKey(c2) !== stamp.key || cur !== msg || (cur.swipe_id ?? 0) !== stamp.swipe || cur.mes !== stamp.text) {
            log('discarded stale result');
            return;
        }

        const parsed = parseUpdate(reply, preset, nm);
        if (!parsed.ok) { lastError = parsed.error; return; }
        const { values } = applyChanges(preset, before.values, parsed.changes);
        writeMessageState(msg, { presetId: preset.id, values, at: Date.now() });
        lastWarnings = parsed.warnings;
        await saveChatNow(c2);
    } catch (e) {
        lastError = e?.message || String(e);
        console.warn('[StatTab] update failed:', e);
    } finally {
        inFlight = false;
        changed();
    }
}

/* ---------- manual edits & schema management ---------- */

async function commitValues(values) {
    const c = stCtx();
    const preset = currentPreset(c);
    if (!preset) return;
    const idx = lastMessageIndex(c.chat);
    if (idx < 0) {
        binding(c).baseline = { values };
        await c.saveMetadata?.();
    } else {
        writeMessageState(c.chat[idx], { presetId: preset.id, values, at: Date.now(), manual: true });
        await saveChatNow(c);
    }
}

async function setValue(entityId, varId, raw) {
    const c = stCtx();
    const preset = currentPreset(c);
    const def = preset?.entities.find((e) => e.id === entityId)?.vars.find((v) => v.id === varId);
    if (!def) return;
    const val = coerceValue(def, raw);
    if (val === null) return;
    const { values } = resolveState(c.chat, preset, binding(c));
    values[entityId][varId] = val;
    await commitValues(values);
    changed();
}

async function resetValues() {
    const c = stCtx();
    const preset = currentPreset(c);
    if (!preset) return;
    await commitValues(Object.fromEntries(preset.entities.map((e) => [e.id, Object.fromEntries(e.vars.map((v) => [v.id, defaultValue(v)]))])));
    changed();
}

async function bindPreset(presetId) {
    const c = stCtx();
    if (!chatKey(c) || !c.chatMetadata) return;
    const known = getSettings().presets.some((p) => p.id === presetId);
    c.chatMetadata[KEY] = { presetId: known ? presetId : null, baseline: binding(c)?.baseline ?? null };
    lastError = '';
    lastWarnings = [];
    await c.saveMetadata?.();
    changed();
}

function savePreset(raw) {
    const s = getSettings();
    const p = normalizePreset(raw);
    const i = s.presets.findIndex((x) => x.id === p.id);
    if (i >= 0) s.presets[i] = p; else s.presets.push(p);
    saveSettings();
    refreshSettingsUi();
    changed();
}

function deletePreset(id) {
    const s = getSettings();
    s.presets = s.presets.filter((p) => p.id !== id);
    if (s.defaultPresetId === id) s.defaultPresetId = '';
    saveSettings();
    refreshSettingsUi();
    changed();
}

/* ---------- stats in the main model's prompt (optional) ---------- */

const INJECT_KEY = 'stat_tab_stats';
let injectionError = '';

/** The text that would be sent right now. genType 'regenerate'/'swipe' means the last reply is being replaced. */
function buildInjection(genType) {
    const c = stCtx();
    const s = getSettings();
    if (!s.enabled || !s.injectEnabled) return '';
    const preset = currentPreset(c);
    if (!preset || !chatKey(c)) return '';
    let chat = c.chat ?? [];
    if ((genType === 'regenerate' || genType === 'swipe') && chat.length && !chat.at(-1).is_user) chat = chat.slice(0, -1);
    const nm = names(c);
    const { values } = resolveState(chat, preset, binding(c));
    return applyInjectionTemplate(s.injectTemplate, renderStatsText({ preset, values, names: nm }), nm);
}

function describeWhere(s) {
    if (s.injectPosition === 'before') return 'Before the main prompt / story string.';
    if (s.injectPosition === 'prompt') return 'After the main prompt / story string.';
    const where = s.injectDepth === 0 ? 'after the last message' : `${s.injectDepth} message${s.injectDepth === 1 ? '' : 's'} from the end of the chat`;
    return `In the chat, ${where}, as a ${s.injectRole} message.`;
}

/** Hand the current text to SillyTavern. An empty text clears it, so this also runs when the feature is off. */
function refreshInjection(genType) {
    injectionError = '';
    try {
        const c = stCtx();
        const s = getSettings();
        if (typeof c.setExtensionPrompt !== 'function') {
            if (s.injectEnabled) injectionError = 'This version of SillyTavern does not let extensions set prompts.';
            return;
        }
        const T = c.extension_prompt_types ?? { IN_PROMPT: 0, IN_CHAT: 1, BEFORE_PROMPT: 2 };
        const R = c.extension_prompt_roles ?? { SYSTEM: 0, USER: 1, ASSISTANT: 2 };
        const position = s.injectPosition === 'before' ? T.BEFORE_PROMPT : s.injectPosition === 'prompt' ? T.IN_PROMPT : T.IN_CHAT;
        const role = s.injectRole === 'user' ? R.USER : s.injectRole === 'assistant' ? R.ASSISTANT : R.SYSTEM;
        c.setExtensionPrompt(INJECT_KEY, buildInjection(genType), position, s.injectDepth, false, role);
    } catch (e) {
        injectionError = e?.message || String(e);
        console.warn('[StatTab] could not set the stats prompt', e);
    }
}

/** State changed outside a generation: refresh the prompt text and tell the tab. */
function changed() {
    refreshInjection();
    push();
}

/* ---------- bridge to the stat tab ---------- */

const chan = new BroadcastChannel(CHANNEL);
let pushQueued = false;

export function snapshot() {
    const c = stCtx();
    const s = getSettings();
    const key = chatKey(c);
    const preset = currentPreset(c);
    const nm = names(c);
    const out = {
        t: 'state',
        enabled: s.enabled,
        hasChat: Boolean(key),
        chatTitle: key ? String(key) : '',
        names: nm,
        presets: s.presets,
        presetId: preset?.id ?? null,
        updating: inFlight,
        error: lastError,
        warnings: lastWarnings,
        profile: activeProfile()?.name ?? null,
        injection: { on: Boolean(s.enabled && s.injectEnabled), text: buildInjection(), where: describeWhere(s), error: injectionError },
        values: null, prevValues: null, updatedAt: null,
    };
    if (preset && key) {
        const r = resolveState(c.chat, preset, binding(c));
        out.values = r.values;
        out.prevValues = r.prevValues;
        out.updatedAt = r.at;
    }
    return out;
}

function push() {
    if (pushQueued) return;
    pushQueued = true;
    queueMicrotask(() => {
        pushQueued = false;
        try { chan.postMessage(snapshot()); } catch (e) { console.warn('[StatTab] push failed', e); }
    });
}

export async function handleMessage(m) {
    if (!m || typeof m !== 'object') return;
    try {
        switch (m.t) {
            case 'hello': push(); break;
            case 'ping': chan.postMessage({ t: 'pong' }); break;
            case 'refresh': await runUpdate(); break;
            case 'set-value': await setValue(m.entityId, m.varId, m.value); break;
            case 'reset': await resetValues(); break;
            case 'bind': await bindPreset(m.presetId || null); break;
            case 'save-preset': savePreset(m.preset); break;
            case 'delete-preset': deletePreset(m.id); break;
        }
    } catch (e) {
        setError(e?.message || String(e));
    }
}
chan.onmessage = (e) => handleMessage(e.data);

/* ---------- ST events ---------- */

const recent = { key: '', at: 0 };

function onMessageReceived(messageId, type) {
    const s = getSettings();
    if (!s.enabled || !s.autoUpdate) return;
    if (type === 'impersonate' || type === 'first_message') return;
    const c = stCtx();
    if (!currentPreset(c)) return;
    const idx = Number(messageId);
    const msg = c.chat?.[idx];
    if (!msg || msg.is_user || msg.is_system || !String(msg.mes ?? '').trim()) return;

    // ST can emit MESSAGE_RECEIVED twice for the same message.
    const k = `${chatKey(c)}:${idx}:${msg.swipe_id ?? 0}`;
    const now = Date.now();
    if (k === recent.key && now - recent.at < 4000) return;
    recent.key = k;
    recent.at = now;
    void runUpdate({ anchorIndex: idx });
}

function registerEvents() {
    const c = stCtx();
    const E = c.eventTypes ?? c.event_types;
    const on = (name, fn) => { if (E?.[name]) c.eventSource.on(E[name], fn); };
    on('CHAT_CHANGED', () => { lastError = ''; lastWarnings = []; autoBindIfNew(); changed(); });
    // Authoritative moment: the prompt is assembled right after this event.
    on('GENERATION_STARTED', (type) => refreshInjection(type));
    on('MESSAGE_RECEIVED', onMessageReceived);
    for (const n of ['MESSAGE_SWIPED', 'MESSAGE_DELETED', 'MESSAGE_EDITED', 'MESSAGE_UPDATED', 'CHAT_DELETED']) on(n, changed);
    on('APP_READY', boot);
}

/* ---------- browser tab ---------- */

let trackerWin = null;

export function openTracker() {
    if (trackerWin && !trackerWin.closed) {
        trackerWin.focus();
        globalThis.toastr?.info('The stat tab is already open. Switch to it from your tab bar.', 'Stat Tab');
        return;
    }
    const url = new URL('tracker.html', import.meta.url).href;
    trackerWin = window.open(url, '_blank');
    if (!trackerWin) globalThis.toastr?.warning('The browser blocked the new tab. Allow pop-ups for this site and try again.', 'Stat Tab');
}

/* ---------- ST UI: menu entry, settings panel, slash command ---------- */

let booted = false;
function boot() {
    if (booted || typeof document === 'undefined') return;
    booted = true;
    addMenuEntry();
    ensureTopBarButton(getSettings().topBarButton);
    addSettingsPanel();
    addSlashCommand();
    autoBindIfNew();
    changed();
}

/**
 * A button in SillyTavern's top bar. It copies the markup of the native drawer icons so it picks up their
 * size and theme, and tries several anchors because custom UI extensions may rearrange the bar.
 * The wand-menu entry and the settings button always remain as fallbacks.
 */
export function ensureTopBarButton(show) {
    if (typeof document === 'undefined') return;
    const existing = document.getElementById('stat_tab_topbar');
    if (!show) { existing?.remove(); return; }
    if (existing) return;

    const wrap = document.createElement('div');
    wrap.id = 'stat_tab_topbar';
    wrap.className = 'drawer';
    wrap.innerHTML = '<div class="drawer-toggle drawer-header"><div class="drawer-icon fa-solid fa-chart-simple fa-fw closedIcon" title="Open Stat Tab"></div></div>';
    // Capture phase: our click must not reach ST's own drawer handlers.
    wrap.addEventListener('click', (e) => { e.preventDefault(); e.stopPropagation(); openTracker(); }, true);

    const after = document.getElementById('extensions-settings-button') || document.getElementById('rightNavHolder');
    const holder = document.getElementById('top-settings-holder') || document.getElementById('top-bar');
    if (after?.parentElement) after.after(wrap);
    else if (holder) holder.append(wrap);
    else console.warn('[StatTab] Could not find the top bar; use the wand menu or the Extensions panel button instead.');
}

function addMenuEntry() {
    const menu = document.getElementById('extensionsMenu');
    if (!menu || document.getElementById('stat_tab_menu_item')) return;
    const item = document.createElement('div');
    item.id = 'stat_tab_menu_item';
    item.className = 'list-group-item flex-container flexGap5';
    item.innerHTML = '<div class="fa-solid fa-chart-simple extensionsMenuExtensionButton"></div><span>Stat Tab</span>';
    item.addEventListener('click', openTracker);
    menu.appendChild(item);
}

function addSlashCommand() {
    try {
        const c = stCtx();
        c.SlashCommandParser?.addCommandObject(c.SlashCommand.fromProps({
            name: 'stattab',
            helpString: 'Open the Stat Tab in a new browser tab.',
            callback: () => { openTracker(); return ''; },
        }));
    } catch (e) {
        console.warn('[StatTab] could not register /stattab', e);
    }
}

const SETTINGS_HTML = `
<div class="inline-drawer" id="stat_tab_settings">
  <div class="inline-drawer-toggle inline-drawer-header">
    <b>Stat Tab</b>
    <div class="inline-drawer-icon fa-solid fa-circle-chevron-down down"></div>
  </div>
  <div class="inline-drawer-content">
    <div class="flex-container flexFlowColumn flexGap5">
      <div class="menu_button menu_button_icon" id="stat_tab_open"><i class="fa-solid fa-up-right-from-square"></i><span>Open stat tab</span></div>
      <label class="checkbox_label"><input type="checkbox" id="stat_tab_enabled"><span>Enabled</span></label>
      <label class="checkbox_label"><input type="checkbox" id="stat_tab_auto"><span>Update after each character message</span></label>
      <label class="checkbox_label"><input type="checkbox" id="stat_tab_card"><span>Send the character card and persona as background</span></label>
      <label class="checkbox_label"><input type="checkbox" id="stat_tab_topbar_opt"><span>Show a button in the top bar</span></label>
      <label class="checkbox_label"><input type="checkbox" id="stat_tab_debug"><span>Log prompts and replies to the console</span></label>
      <label for="stat_tab_profile">Connection profile</label>
      <select id="stat_tab_profile" class="text_pole"></select>
      <label for="stat_tab_default">Schema for new chats</label>
      <select id="stat_tab_default" class="text_pole"></select>
      <label for="stat_tab_ctx">Messages sent as context</label>
      <input id="stat_tab_ctx" class="text_pole" type="number" min="1" max="30">
      <label for="stat_tab_tokens">Max reply tokens</label>
      <input id="stat_tab_tokens" class="text_pole" type="number" min="100" max="32000" step="50">
      <label for="stat_tab_timeout">Give up after (seconds)</label>
      <input id="stat_tab_timeout" class="text_pole" type="number" min="10" max="600" step="10">
      <label for="stat_tab_sys">System prompt</label>
      <textarea id="stat_tab_sys" class="text_pole textarea_compact" rows="4"></textarea>
      <div class="menu_button menu_button_icon" id="stat_tab_sys_reset"><i class="fa-solid fa-rotate-left"></i><span>Reset system prompt</span></div>
      <label for="stat_tab_rules">Rules</label>
      <textarea id="stat_tab_rules" class="text_pole textarea_compact" rows="7"></textarea>
      <div class="menu_button menu_button_icon" id="stat_tab_rules_reset"><i class="fa-solid fa-rotate-left"></i><span>Reset rules</span></div>
      <hr>
      <label class="checkbox_label"><input type="checkbox" id="stat_tab_inj_on"><span>Send stats to the main model</span></label>
      <label for="stat_tab_inj_pos">Where in the prompt</label>
      <select id="stat_tab_inj_pos" class="text_pole">
        <option value="chat">In the chat, at a depth</option>
        <option value="prompt">After the main prompt / story string</option>
        <option value="before">Before the main prompt / story string</option>
      </select>
      <label for="stat_tab_inj_depth">Depth (in-chat only; 0 = after the last message)</label>
      <input id="stat_tab_inj_depth" class="text_pole" type="number" min="0" max="9999">
      <label for="stat_tab_inj_role">Role</label>
      <select id="stat_tab_inj_role" class="text_pole">
        <option value="system">System</option>
        <option value="user">User</option>
        <option value="assistant">Assistant</option>
      </select>
      <label for="stat_tab_inj_tpl">Template</label>
      <textarea id="stat_tab_inj_tpl" class="text_pole textarea_compact" rows="4"></textarea>
      <div class="menu_button menu_button_icon" id="stat_tab_inj_tpl_reset"><i class="fa-solid fa-rotate-left"></i><span>Reset template</span></div>
      <small>{{stats}} marks where the stat list goes (it is appended if missing). Unset stats and stats marked private are left out. The stat tab shows exactly what is sent.</small>
      <hr>
      <small>{{user}} and {{char}} work in both. The stat list, conversation and reply format are always added for you. Schemas are edited in the stat tab, where each schema also has its own instructions.</small>
    </div>
  </div>
</div>`;

function addSettingsPanel() {
    const host = document.getElementById('extensions_settings2') || document.getElementById('extensions_settings');
    if (!host || document.getElementById('stat_tab_settings')) return;
    host.insertAdjacentHTML('beforeend', SETTINGS_HTML);
    const $ = (id) => document.getElementById(id);
    const s = getSettings();
    $('stat_tab_open').addEventListener('click', openTracker);

    const bindCheck = (id, key) => {
        $(id).checked = Boolean(s[key]);
        $(id).addEventListener('change', (e) => { getSettings()[key] = e.target.checked; saveSettings(); changed(); });
    };
    bindCheck('stat_tab_enabled', 'enabled');
    bindCheck('stat_tab_auto', 'autoUpdate');
    bindCheck('stat_tab_card', 'includeCard');
    bindCheck('stat_tab_debug', 'debug');
    $('stat_tab_topbar_opt').checked = Boolean(s.topBarButton);
    $('stat_tab_topbar_opt').addEventListener('change', (e) => { getSettings().topBarButton = e.target.checked; saveSettings(); ensureTopBarButton(e.target.checked); });

    // The boxes show the text in effect; saving the default text back stores '' so future default changes apply.
    const bindPrompt = (id, resetId, key, fallback) => {
        const el = $(id);
        el.value = s[key] || fallback;
        el.addEventListener('change', () => {
            getSettings()[key] = el.value.trim() === fallback.trim() ? '' : el.value;
            saveSettings();
            changed();
        });
        $(resetId).addEventListener('click', () => { el.value = fallback; getSettings()[key] = ''; saveSettings(); changed(); });
    };
    bindPrompt('stat_tab_sys', 'stat_tab_sys_reset', 'systemPrompt', DEFAULT_SYSTEM_PROMPT);
    bindPrompt('stat_tab_rules', 'stat_tab_rules_reset', 'rules', DEFAULT_RULES);
    bindCheck('stat_tab_inj_on', 'injectEnabled');
    bindPrompt('stat_tab_inj_tpl', 'stat_tab_inj_tpl_reset', 'injectTemplate', DEFAULT_INJECT_TEMPLATE);

    const bindNum = (id, key, min, max) => {
        $(id).value = s[key];
        $(id).addEventListener('change', (e) => {
            const raw = Number(e.target.value);
            const n = Math.min(max, Math.max(min, Number.isFinite(raw) && e.target.value !== '' ? Math.round(raw) : DEFAULTS[key]));
            e.target.value = n;
            getSettings()[key] = n;
            saveSettings();
            changed();
        });
    };
    bindNum('stat_tab_ctx', 'contextMessages', 1, 30);
    bindNum('stat_tab_tokens', 'maxTokens', 100, 32000);
    bindNum('stat_tab_timeout', 'timeoutSeconds', 10, 600);
    bindNum('stat_tab_inj_depth', 'injectDepth', 0, 9999);
    const bindSelect = (id, key) => {
        $(id).value = s[key];
        $(id).addEventListener('change', (e) => { getSettings()[key] = e.target.value; saveSettings(); syncInjectionUi(); changed(); });
    };
    const syncInjectionUi = () => { $('stat_tab_inj_depth').disabled = getSettings().injectPosition !== 'chat'; };
    bindSelect('stat_tab_inj_pos', 'injectPosition');
    bindSelect('stat_tab_inj_role', 'injectRole');
    syncInjectionUi();

    $('stat_tab_profile').addEventListener('change', (e) => { getSettings().profileId = e.target.value; saveSettings(); push(); });
    $('stat_tab_default').addEventListener('change', (e) => { getSettings().defaultPresetId = e.target.value; saveSettings(); });
    $('stat_tab_settings').querySelector('.inline-drawer-toggle').addEventListener('click', refreshSettingsUi);
    refreshSettingsUi();
}

function refreshSettingsUi() {
    if (typeof document === 'undefined' || !document.getElementById('stat_tab_profile')) return;
    const s = getSettings();
    const fill = (id, options, selected) => {
        const el = document.getElementById(id);
        el.replaceChildren(...options.map(([value, label]) => {
            const o = document.createElement('option');
            o.value = value;
            o.textContent = label;
            return o;
        }));
        el.value = options.some(([v]) => v === selected) ? selected : options[0][0];
    };
    fill('stat_tab_profile', [['', 'Currently selected profile'], ...listProfiles().map((p) => [p.id, p.name])], s.profileId);
    fill('stat_tab_default', [['', 'None'], ...s.presets.map((p) => [p.id, p.name])], s.defaultPresetId);
}

/* ---------- start ---------- */

registerEvents();
if (typeof document !== 'undefined' && document.getElementById('extensionsMenu')) boot();

export const _internal = { labelled, getSettings, boot, buildInjection };
