// @ts-check
// The rail's filter controls, in place of native <select>s: a short list is a
// radio group drawn as pills or a segment (every choice in sight, one tap on a
// phone), and the faculty list, too long for that, is a combobox that filters
// as the student types (the WAI-ARIA APG "select-only combobox" with a text
// box). Its list opens in the flow under the box, not over the page, so in the
// phone's filters dialog it scrolls with the dialog and the keyboard never
// covers it. Both answer to `.value`, `focus()` and a bubbling `change` on
// their root, as the selects did, so the controller reads them the same way.

import { h } from './dom.js';

/** @typedef {import('./dom.js').Child} Child */

/**
 * @typedef {object} Choice
 * @property {string} value  the chosen value ('' for "any")
 * @property {HTMLElement} root  the control's element; `change` bubbles from it
 * @property {(value: string, label: string | Child[] | ((one: string) => string | Child[])) => void} ensure  adds an option the list lacks (a shared link's value; a multi group's label is per value)
 * @property {() => void} focus
 */

/**
 * A radio group drawn as pills (or, for the rows `seg` names, a segment):
 * each radio covers its label, so the whole shape is the target. Arrow keys
 * move and choose within it, as in any radio group. With `multi`, the pills
 * are checkboxes and `.value` is the chosen values comma-separated in numeric
 * order ('3,4'): the first option ('' , "Any") clears the others, choosing
 * any other clears it, and clearing the last choice checks it again.
 * @param {HTMLElement} root  the fieldset the pills go in
 * @param {string} name  the radios' name
 * @param {{ value: string, label: string | Child[] }[]} options  a label may carry visually hidden words (the "Level " before a level's figure), so a pill says what its chip says
 * @param {{ seg?: number, multi?: boolean }} [opts]  the first `seg` options form a segment, the rest pills under it
 * @returns {Choice}
 */
export function pillGroup(root, name, options, { seg = 0, multi = false } = {}) {
  const type = multi ? 'checkbox' : 'radio';
  /** @param {string} value @param {string | Child[]} label */
  const pill = (value, label, cls = 'pill pill-s') => h('label', { class: cls },
    h('input', { attrs: { type, name, value } }), ...(Array.isArray(label) ? label : [label]));
  const segRow = seg ? h('div', { class: 'seg' }, ...options.slice(0, seg).map((o) => pill(o.value, o.label, 'seg-opt'))) : null;
  const pills = h('div', { class: 'pills pills-s' }, ...options.slice(seg).map((o) => pill(o.value, o.label)));
  root.append(...[segRow, pills].filter((x) => x !== null));
  const radios = () => /** @type {HTMLInputElement[]} */ ([...root.querySelectorAll(`input[type="${type}"][name="${name}"]`)]);
  /** Puts a multi group's Tab stop on its first chosen pill, unless focus is in the group. @type {() => void} */
  let roving = () => {};
  if (multi) {
    // Before the page's own change listener on the root: the boxes are
    // squared up (Any against the rest) by the time it reads `.value`.
    root.addEventListener('change', (e) => {
      const box = e.target;
      if (!(box instanceof HTMLInputElement) || box.name !== name) return;
      const all = radios();
      if (box.value === '' || !all.some((r) => r.checked && r.value !== '')) for (const r of all) r.checked = r.value === '';
      else for (const r of all) if (r.value === '') r.checked = false;
    }, { capture: true });
    // One Tab stop for the group, as a radio group has: arrow keys, Home and
    // End move along the pills, and Space checks or clears the one in focus.
    /** @param {HTMLInputElement} [to] */
    const rove = (to) => {
      const all = radios();
      const at = to ?? all.find((r) => r.checked) ?? all[0];
      for (const r of all) r.tabIndex = r === at ? 0 : -1;
    };
    root.addEventListener('focusin', (e) => { if (e.target instanceof HTMLInputElement && e.target.name === name) rove(e.target); });
    root.addEventListener('keydown', (e) => {
      const all = radios();
      const at = all.indexOf(/** @type {HTMLInputElement} */ (e.target));
      if (at < 0 || e.altKey || e.ctrlKey || e.metaKey || e.shiftKey) return;
      const next = { ArrowRight: at + 1, ArrowDown: at + 1, ArrowLeft: at - 1, ArrowUp: at - 1, Home: 0, End: all.length - 1 }[e.key];
      if (next === undefined) return;
      e.preventDefault();
      all[(next + all.length) % all.length].focus();
    });
    queueMicrotask(() => rove());
    roving = () => rove();
  }
  return {
    root,
    get value() {
      const on = radios().filter((r) => r.checked && r.value !== '').map((r) => r.value);
      return multi ? on.sort((a, b) => Number(a) - Number(b)).join(',') : radios().find((r) => r.checked)?.value ?? '';
    },
    set value(v) {
      // '' with no "any" option (the year of study) unchecks the group.
      const want = multi ? new Set(v ? v.split(',') : ['']) : new Set([v]);
      for (const r of radios()) r.checked = want.has(r.value);
      if (!root.contains(document.activeElement)) roving();
    },
    ensure(value, label) {
      for (const one of multi ? value.split(',') : [value]) {
        if (one && !radios().some((r) => r.value === one)) pills.append(pill(one, typeof label === 'function' ? label(one) : label));
      }
      // One Tab stop still: a pill added while focus is in the group waits its turn.
      if (multi) {
        if (root.contains(document.activeElement)) for (const r of radios()) r.tabIndex = r === document.activeElement ? 0 : -1;
        else roving();
      }
    },
    // Where Tab would land: the chosen radio, else the first.
    focus() { (radios().find((r) => r.checked) ?? radios()[0])?.focus(); },
  };
}

/**
 * @typedef {object} ComboOption
 * @property {string} value
 * @property {string} label  what the box and the list say
 * @property {string} [note]  a quiet figure after it (the faculty's course count)
 */

/**
 * The faculty combobox: a text box that names the choice, and a listbox under
 * it, opened by a click, a typed letter, Down or Alt+Down. Typing filters the
 * list by any part of a name; Up and Down move the active option
 * (aria-activedescendant, so focus stays in the box); Enter or a click
 * chooses; Escape, Tab or leaving puts the chosen name back. Only a choice
 * fires `change`.
 * @param {HTMLElement} root  the wrapper (its <label> already points at `inputId`)
 * @param {string} inputId
 * @param {ComboOption} any  the first option, value ''
 * @returns {Choice & { upsert: (o: ComboOption) => void, retain: (values: Set<string>) => void, readonly open: boolean }}
 */
export function combobox(root, inputId, any) {
  const listId = `${inputId}-list`;
  const input = h('input', { class: 'combo-in', attrs: {
    id: inputId, type: 'text', role: 'combobox', 'aria-expanded': 'false', 'aria-controls': listId,
    'aria-autocomplete': 'list', autocomplete: 'off', autocapitalize: 'off', spellcheck: 'false', placeholder: any.label,
  } });
  const caret = h('span', { class: 'combo-caret', attrs: { 'aria-hidden': 'true' } });
  const list = h('ul', { class: 'combo-list', attrs: { id: listId, role: 'listbox', 'aria-label': root.querySelector('label')?.textContent ?? '' } });
  list.hidden = true;
  root.append(h('div', { class: 'combo' }, input, caret), list);

  /** @type {ComboOption[]} */
  let options = [any];
  let value = '';
  let query = '';
  let active = 0;

  const labelOf = (/** @type {string} */ v) => (v ? options.find((o) => o.value === v)?.label ?? v : '');
  const shown = () => {
    const q = query.trim().toLowerCase();
    if (!q) return options;
    // The name that starts with it first, then a word that does, then any part.
    const rank = (/** @type {string} */ l) => (l.startsWith(q) ? 0 : l.includes(` ${q}`) || l.includes(`-${q}`) ? 1 : 2);
    return options.map((o) => ({ o, l: o.label.toLowerCase() }))
      .filter(({ o, l }) => o.value && l.includes(q))
      .sort((x, y) => rank(x.l) - rank(y.l))
      .map(({ o }) => o);
  };
  const isOpen = () => !list.hidden;
  const typing = () => document.activeElement === input && isOpen();

  /** The list's rows, the typed part of each name marked. */
  function draw() {
    const rows = shown();
    const q = query.trim().toLowerCase();
    if (!rows.length) {
      list.replaceChildren(h('li', { class: 'combo-none', attrs: { role: 'presentation' } }, `No faculty matches “${query.trim()}”`));
      input.removeAttribute('aria-activedescendant');
      return;
    }
    active = Math.min(Math.max(active, 0), rows.length - 1);
    list.replaceChildren(...rows.map((o, i) => {
      const at = q ? o.label.toLowerCase().indexOf(q) : -1;
      const name = at < 0 ? o.label : h('span', null, o.label.slice(0, at), h('mark', null, o.label.slice(at, at + q.length)), o.label.slice(at + q.length));
      const li = h('li', { class: i === active ? 'combo-opt on' : 'combo-opt', attrs: {
        id: `${listId}-${i}`, role: 'option', 'aria-selected': String(o.value === value), 'data-value': o.value,
      } }, h('span', { class: 'combo-name' }, name), o.note ? h('span', { class: 'vh' }, ', ') : null, o.note ? h('span', { class: 'combo-note' }, o.note) : null);
      return li;
    }));
    input.setAttribute('aria-activedescendant', `${listId}-${active}`);
  }

  /** Moves the active option and keeps it in the list's view (only the list scrolls). @param {number} to */
  function moveTo(to) {
    active = to;
    draw();
    const on = /** @type {HTMLElement | null} */ (list.querySelector('.on'));
    if (!on) return;
    if (on.offsetTop < list.scrollTop) list.scrollTop = on.offsetTop;
    else if (on.offsetTop + on.offsetHeight > list.scrollTop + list.clientHeight) list.scrollTop = on.offsetTop + on.offsetHeight - list.clientHeight;
  }

  /** @param {boolean} on */
  function setOpen(on) {
    if (on === isOpen()) { if (on) draw(); return; }
    list.hidden = !on;
    input.setAttribute('aria-expanded', String(on));
    if (on) {
      moveTo(Math.max(0, shown().findIndex((o) => o.value === value)));
      // On a phone the keyboard takes the lower half: bring the box to the top
      // of what scrolls, so the list opens into the space under it.
      if (matchMedia('(max-width: 640px)').matches) input.scrollIntoView({ block: 'start' });
    } else {
      input.removeAttribute('aria-activedescendant');
    }
  }

  /** Back to the chosen name, the list closed. */
  function reset() {
    query = '';
    input.value = labelOf(value);
    // The chosen value, apart from the name the box shows (a link's faculty is quoted).
    input.dataset.value = value;
    setOpen(false);
  }

  /** @param {string} v */
  function choose(v) {
    const changed = v !== value;
    value = v;
    reset();
    if (changed) root.dispatchEvent(new Event('change', { bubbles: true }));
  }

  // Focus selects the name, so typing replaces it. WebKit then skips scrolling a
  // box Tab reached into view, so the box does it.
  input.addEventListener('focus', () => {
    input.select();
    input.scrollIntoView({ block: 'nearest' });
  });
  // A press that opens the list selects the name, so typing replaces it. On
  // mouseup, not focus alone: WebKit's mouseup puts the caret back where the
  // press was, and a press on a box that already has focus fires no focus.
  let selectOnUp = false;
  input.addEventListener('mousedown', () => { selectOnUp = !isOpen(); });
  input.addEventListener('mouseup', (e) => {
    if (!selectOnUp) return;
    selectOnUp = false;
    e.preventDefault();
    input.select();
  });
  input.addEventListener('click', () => setOpen(!isOpen() || query !== ''));
  input.addEventListener('input', () => {
    query = input.value;
    setOpen(true);
    // The best match, not the current choice: typing asks for something else.
    moveTo(0);
  });
  // The text box's own `change` (on leaving it after typing) is not a choice:
  // only `choose` tells the page.
  input.addEventListener('change', (e) => e.stopPropagation());
  input.addEventListener('blur', reset);
  input.addEventListener('keydown', (e) => {
    if (e.isComposing) return;
    const rows = shown();
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault();
      if (!isOpen() || e.altKey) { setOpen(!isOpen() || e.key === 'ArrowDown'); return; }
      moveTo(active + (e.key === 'ArrowDown' ? 1 : -1));
    } else if (e.key === 'Home' || e.key === 'End') {
      if (!isOpen()) return;
      e.preventDefault();
      moveTo(e.key === 'Home' ? 0 : rows.length - 1);
    } else if (e.key === 'Enter') {
      // Closed, Enter does nothing (the rail is outside the search form); open, it chooses.
      if (!isOpen()) return;
      e.preventDefault();
      if (rows[active]) choose(rows[active].value);
    } else if (e.key === 'Escape') {
      // Open, Escape closes the list only: not the filters dialog, not a detail.
      if (!isOpen() && !query) return;
      e.preventDefault();
      e.stopPropagation();
      reset();
      input.select();
    }
  });
  // A press on an option keeps focus in the box (no blur, which would reset
  // the list first); the click then chooses.
  list.addEventListener('mousedown', (e) => e.preventDefault());
  list.addEventListener('click', (e) => {
    const li = e.target instanceof Element ? e.target.closest('li[role="option"]') : null;
    if (li instanceof HTMLElement) choose(li.dataset.value ?? '');
  });

  return {
    root,
    get value() { return value; },
    // A choice from outside (Back, a link's faculty dropped) is the choice at
    // once; while the student is typing in the open list, their text stays.
    set value(v) {
      value = v;
      input.dataset.value = v;
      if (typing()) draw();
      else reset();
    },
    get open() { return isOpen(); },
    ensure(v, label) {
      // The faculty's labels are text: a link's own value comes quoted (format.js quoteUser).
      if (v && !options.some((o) => o.value === v)) options = [...options, { value: v, label: typeof label === 'string' ? label : v }];
      if (v === value && !typing()) input.value = labelOf(value);
    },
    upsert(o) {
      const at = options.findIndex((x) => x.value === o.value);
      options = at < 0 ? [...options, o] : options.map((x, i) => (i === at ? o : x));
      if (o.value === value && !isOpen()) input.value = labelOf(value);
      if (isOpen()) draw();
    },
    retain(values) {
      options = options.filter((o) => !o.value || values.has(o.value));
      if (isOpen()) draw();
    },
    focus() { input.focus(); },
  };
}
