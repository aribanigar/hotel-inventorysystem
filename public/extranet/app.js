// Hotel Extranet web app. Plain ES modules, no build step.
// Security: every piece of server data is written with textContent (never innerHTML),
// and every request carries X-Extranet: 1 (CSRF guard; the session cookie is HttpOnly).

const API = '/api/v1/hotelier';
const DAYS = 14;
const SOURCES = [
  ['WALK_IN', 'Walk-in'], ['PHONE', 'Phone'], ['WHATSAPP', 'WhatsApp'],
  ['TRAVEL_AGENT', 'Travel agent'], ['OTHER_OTA', 'Other OTA'], ['OTHER', 'Other'],
];
const STATUS_LABEL = { CONFIRMED: 'Confirmed', CHECKED_IN: 'Checked in', CHECKED_OUT: 'Checked out', CANCELLED: 'Cancelled', NO_SHOW: 'No-show' };
const NEXT_ACTIONS = {
  CONFIRMED: [['CHECKED_IN', 'Check in', 'btn-primary'], ['NO_SHOW', 'No-show', 'btn-ghost'], ['CANCELLED', 'Cancel', 'btn-danger']],
  CHECKED_IN: [['CHECKED_OUT', 'Check out', 'btn-primary']],
};
const MEALS = { EP: 'Room only', CP: 'Breakfast', MAP: 'Breakfast + dinner', AP: 'All meals' };
const WEEKDAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const RANK = { frontdesk: 1, manager: 2, owner: 3 };

const state = {
  user: null, hotels: [], hotel: null, calStart: null, calendar: null, setup: null,
  view: { rooms: true, rates: true, restrictions: false },
  update: null,
};

// ---------------------------------------------------------------- utilities
const $ = (sel) => document.querySelector(sel);

function h(tag, attrs = {}, ...children) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (v === undefined || v === null || v === false) continue;
    if (k.startsWith('on') && typeof v === 'function') el.addEventListener(k.slice(2), v);
    else if (k === 'class') el.className = v;
    else if (k === 'dataset') Object.assign(el.dataset, v);
    else if (k === 'checked' || k === 'value') el[k] = v;
    else el.setAttribute(k, v === true ? '' : String(v));
  }
  for (const c of children.flat()) {
    if (c === null || c === undefined || c === false) continue;
    el.append(c instanceof Node ? c : document.createTextNode(String(c)));
  }
  return el;
}

const addDays = (iso, n) => new Date(Date.parse(iso + 'T00:00:00Z') + n * 86400000).toISOString().slice(0, 10);
const nightsBetween = (a, b) => Math.round((Date.parse(b + 'T00:00:00Z') - Date.parse(a + 'T00:00:00Z')) / 86400000);
const dow = (iso) => new Date(iso + 'T00:00:00Z').getUTCDay();
const fmtDay = (iso) => new Date(iso + 'T00:00:00Z').toLocaleDateString('en-IN', { weekday: 'short', timeZone: 'UTC' });
const fmtDate = (iso) => new Date(iso + 'T00:00:00Z').toLocaleDateString('en-IN', { day: 'numeric', month: 'short', timeZone: 'UTC' });
const fmtLong = (iso) => new Date(iso + 'T00:00:00Z').toLocaleDateString('en-IN', { weekday: 'short', day: 'numeric', month: 'short', year: 'numeric', timeZone: 'UTC' });
const fmtWhen = (ts) => (ts ? new Date(ts).toLocaleString('en-IN', { dateStyle: 'medium', timeStyle: 'short' }) : 'never');
const inr = (minor, currency = 'INR') =>
  minor === null || minor === undefined ? '' : new Intl.NumberFormat('en-IN', { style: 'currency', currency, maximumFractionDigits: minor % 100 ? 2 : 0 }).format(minor / 100);
const inrShort = (minor) => (minor === null || minor === undefined ? '' : minor >= 100000 ? `${(minor / 100000).toFixed(minor % 100000 ? 1 : 0)}k` : String(Math.round(minor / 100)));

/** "8,500.50" -> 850050 paise, exactly. Null for blank, NaN for junk. allowZero for extras. */
function toPaise(text, allowZero = false) {
  const s = String(text ?? '').replace(/[,\s]/g, '').replace(/^(Rs\.?|INR)/i, '');
  if (s === '') return null;
  if (!/^\d+(\.\d{1,2})?$/.test(s)) return NaN;
  const [whole, frac = ''] = s.split('.');
  const v = Number(whole) * 100 + Number((frac + '00').slice(0, 2));
  return v === 0 && !allowZero ? NaN : v;
}

let toastTimer;
function toast(message, kind = 'ok') {
  const t = $('#toast');
  t.textContent = message;
  t.className = 'toast' + (kind === 'error' ? ' error' : '');
  t.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => (t.hidden = true), kind === 'error' ? 6000 : 3500);
}

class ApiError extends Error {
  constructor(status, body) {
    super(body?.error?.message || `Request failed (${status})`);
    this.status = status;
    this.code = body?.error?.code;
    this.details = body?.error?.details;
  }
}

async function api(method, path, body) {
  let res;
  try {
    res = await fetch(API + path, {
      method,
      credentials: 'same-origin',
      headers: { 'x-extranet': '1', ...(body ? { 'content-type': 'application/json' } : {}) },
      body: body ? JSON.stringify(body) : undefined,
    });
  } catch {
    throw new ApiError(0, { error: { message: 'No connection. Check your internet and try again.' } });
  }
  const data = await res.json().catch(() => ({}));
  if (res.status === 401 && path !== '/session') {
    showLogin();
    throw new ApiError(401, data);
  }
  if (!res.ok) throw new ApiError(res.status, data);
  return data;
}

function explain(err) {
  if (err.code === 'SOLD_OUT' && err.details?.nights) {
    const parts = err.details.nights.map((n) => (n.loaded === false ? `${fmtDate(n.date)} (no rooms set)` : `${fmtDate(n.date)} (${n.available} left)`));
    return `Not enough rooms: ${parts.join(', ')}.`;
  }
  if (err.code === 'INVENTORY_BUSY') return 'Someone is booking these dates right now. Try again in a moment.';
  if (err.code === 'VALIDATION_ERROR' && err.details?.issues) {
    const f = Object.entries(err.details.issues.fieldErrors ?? {})[0];
    if (f) return `${f[0]}: ${f[1][0]}`;
    if (err.details.issues.formErrors?.[0]) return err.details.issues.formErrors[0];
  }
  return err.message;
}

function showErr(el, msg) {
  el.textContent = msg;
  el.hidden = false;
}

const role = () => RANK[state.hotel?.role] ?? 0;
const managed = () => state.hotel?.source === 'EXTRANET';
const canEdit = () => managed() && role() >= RANK.manager;
const canSell = () => managed();

// ---------------------------------------------------------------- auth
function showLogin() {
  $('#app-view').hidden = true;
  $('#login-view').hidden = false;
  document.querySelectorAll('dialog[open]').forEach((d) => d.close());
  $('#login-form [name=email]').focus();
}

$('#login-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const f = e.currentTarget;
  const err = $('#login-error');
  err.hidden = true;
  const btn = f.querySelector('button[type=submit]');
  btn.disabled = true;
  try {
    await api('POST', '/session', { email: f.email.value.trim(), password: f.password.value });
    f.password.value = '';
    await boot();
  } catch (ex) {
    showErr(err, ex.message);
  } finally {
    btn.disabled = false;
  }
});

$('#logout-btn').addEventListener('click', async () => {
  await api('DELETE', '/session').catch(() => {});
  state.user = null;
  showLogin();
});

async function boot() {
  let me;
  try {
    me = await api('GET', '/me');
  } catch {
    return;
  }
  state.user = me.user;
  state.hotels = me.hotels;
  $('#user-name').textContent = me.user.name;
  $('#hotel-select').replaceChildren(...me.hotels.map((ht) => h('option', { value: ht.id }, ht.name)));
  $('#login-view').hidden = true;
  $('#app-view').hidden = false;
  if (!me.hotels.length) {
    $('#cal-grid').replaceChildren(h('div', { class: 'empty' }, 'Your account has no hotels yet. Ask your administrator for access.'));
    return;
  }
  let remembered = null;
  try { remembered = localStorage.getItem('hx_hotel'); } catch { /* storage blocked */ }
  const pick = me.hotels.find((x) => x.id === remembered) ?? me.hotels[0];
  $('#hotel-select').value = pick.id;
  await selectHotel(pick.id);
}

$('#hotel-select').addEventListener('change', (e) => selectHotel(e.target.value));

async function selectHotel(id) {
  state.hotel = state.hotels.find((x) => x.id === id);
  state.setup = null;
  try { localStorage.setItem('hx_hotel', id); } catch { /* ignore */ }
  state.calStart = state.hotel.today;
  const labels = { EXTRANET: 'Managed here', CHANNEL_MANAGER: 'Channel manager', EXTERNAL_B2B: 'B2B supplier' };
  $('#source-badge').textContent = `${labels[state.hotel.source] ?? state.hotel.source} · ${state.hotel.role}`;
  $('#bk-from').value = state.hotel.today;
  $('#bk-to').value = addDays(state.hotel.today, 30);
  for (const b of [$('#new-booking-btn'), $('#new-booking-btn-2')]) b.hidden = !canSell();
  $('#bulk-btn').hidden = !canEdit();
  for (const t of ['setup', 'channels']) document.querySelector(`.tab[data-tab=${t}]`).hidden = role() < RANK.manager;
  if (role() < RANK.manager && ['setup', 'channels', 'activity'].includes(currentTab())) selectTab('calendar');
  await loadCalendar();
  refreshTab();
}

// ---------------------------------------------------------------- tabs
const currentTab = () => document.querySelector('.tab[aria-selected="true"]').dataset.tab;
function selectTab(name) {
  document.querySelectorAll('.tab').forEach((t) => t.setAttribute('aria-selected', String(t.dataset.tab === name)));
  for (const n of ['calendar', 'bookings', 'setup', 'channels', 'activity']) $(`#tab-${n}`).hidden = n !== name;
  refreshTab();
}
function refreshTab() {
  const t = currentTab();
  if (t === 'bookings') loadBookings();
  if (t === 'setup') loadSetup();
  if (t === 'channels') loadChannels();
  if (t === 'activity') loadActivity();
}
document.querySelectorAll('.tab').forEach((tab) => tab.addEventListener('click', () => selectTab(tab.dataset.tab)));

// ---------------------------------------------------------------- calendar
$('#cal-prev').addEventListener('click', () => { state.calStart = addDays(state.calStart, -DAYS); loadCalendar(); });
$('#cal-next').addEventListener('click', () => { state.calStart = addDays(state.calStart, DAYS); loadCalendar(); });
$('#cal-today').addEventListener('click', () => { state.calStart = state.hotel.today; loadCalendar(); });
document.querySelectorAll('[data-view]').forEach((chip) =>
  chip.addEventListener('click', () => {
    state.view[chip.dataset.view] = !state.view[chip.dataset.view];
    chip.setAttribute('aria-pressed', String(state.view[chip.dataset.view]));
    if (state.calendar) renderCalendar(state.calendar);
  }),
);

async function loadCalendar() {
  try {
    const data = await api('GET', `/hotels/${state.hotel.id}/calendar?from=${state.calStart}&days=${DAYS}`);
    state.calendar = data;
    renderCalendar(data);
  } catch (err) {
    if (err.status !== 401) $('#cal-grid').replaceChildren(h('div', { class: 'empty' }, explain(err)));
  }
}

function renderCalendar(data) {
  $('#cal-range').textContent = `${fmtDate(data.from)} to ${fmtDate(data.to)}`;
  const banner = $('#managed-banner');
  banner.hidden = data.hotel.editable;
  if (!data.hotel.editable) {
    banner.textContent = data.hotel.managedBy
      ? `Rooms and rates for this hotel come from ${data.hotel.managedBy}. Make changes and record walk-ins there; they sync here automatically.`
      : 'Rooms and rates for this hotel come from an external supplier and are view-only here.';
  }
  if (!data.roomTypes.length) {
    $('#cal-grid').replaceChildren(h('div', { class: 'empty' }, canEdit() ? 'No room types yet. Add your first one in Setup.' : 'No room types set up for this hotel yet.'));
    return;
  }
  const today = state.hotel.today;
  const head = h('tr', {}, h('th', { class: 'room', scope: 'col' }, 'Room type'),
    data.dates.map((d) => h('th', { scope: 'col', class: [d === today ? 'today' : '', dow(d) === 0 || dow(d) === 6 ? 'weekend' : ''].join(' ') },
      fmtDay(d), h('span', { class: 'dnum' }, new Date(d + 'T00:00:00Z').getUTCDate()))));
  const rows = [];
  for (const rt of data.roomTypes) {
    if (state.view.rooms || (!state.view.rates && !state.view.restrictions)) {
      rows.push(h('tr', {},
        h('th', { class: 'room', scope: 'row' }, h('span', { class: 'rname' }, rt.name), h('span', { class: 'rplan' }, 'Rooms left to sell')),
        rt.days.map((day) => h('td', {}, roomCell(rt, day, today)))));
    }
    for (const plan of rt.ratePlans ?? []) {
      if (state.view.rates) {
        rows.push(h('tr', { class: 'plan' },
          h('th', { class: 'room', scope: 'row' },
            h('span', { class: 'rname' }, plan.name, plan.rateMode === 'DERIVED' ? h('span', { class: 'auto' }, 'AUTO') : null),
            h('span', { class: 'rplan' }, plan.rule ? `follows ${plan.rule}` : MEALS[plan.mealPlan] ?? plan.mealPlan)),
          plan.days.map((pd) => h('td', {}, priceCell(rt, plan, pd)))));
      }
      if (state.view.restrictions) {
        rows.push(h('tr', { class: 'plan' },
          h('th', { class: 'room', scope: 'row' }, h('span', { class: 'rname' }, plan.name), h('span', { class: 'rplan' }, 'Restrictions')),
          plan.days.map((pd) => h('td', {}, restrictionCell(rt, plan, pd)))));
      }
    }
  }
  $('#cal-grid').replaceChildren(h('table', { class: 'cal' }, h('thead', {}, head), h('tbody', {}, rows)));
}

function roomCell(rt, day, today) {
  let cls = 'free';
  if (!day.loaded) cls = 'unloaded';
  else if (day.stopSell) cls = 'closed';
  else if (day.available === 0) cls = 'out';
  else if (day.available === 1) cls = 'low';
  const sold = day.soldOffline + day.soldOnline;
  const tags = [sold ? `${sold} sold` : '', day.held ? `${day.held} in checkout` : ''].filter(Boolean).join(' · ');
  const label = `${rt.name}, ${fmtLong(day.date)}: ${day.loaded ? `${day.available} left` : 'no rooms set'}${day.stopSell ? ', closed' : ''}`;
  return h('button', { type: 'button', class: `cell ${cls}${day.date < today ? ' past' : ''}`, 'aria-label': label, onclick: () => openUpdate({ rt, date: day.date }) },
    h('span', { class: 'avail' }, day.loaded ? day.available : '-'),
    h('span', { class: 'price' }, day.priceMinor ? inrShort(day.priceMinor) : ''),
    tags ? h('span', { class: 'tags' }, tags) : null);
}

function priceCell(rt, plan, pd) {
  const cls = ['pcell', plan.rateMode === 'DERIVED' ? 'derived' : '', pd.stopSell ? 'closed' : '', pd.priceMinor ? '' : 'empty'].join(' ');
  const label = `${plan.name}, ${fmtLong(pd.date)}: ${pd.priceMinor ? inr(pd.priceMinor) : 'no price'}${pd.stopSell ? ', closed' : ''}`;
  return h('button', { type: 'button', class: cls, 'aria-label': label, onclick: () => openUpdate({ rt, plan, date: pd.date }) },
    pd.priceMinor ? inrShort(pd.priceMinor) : 'set');
}

function restrictionCell(rt, plan, pd) {
  const tags = [];
  if (pd.stopSell) tags.push(['CLOSED', 'cl']);
  if (pd.closedToArrival) tags.push(['CTA', 'cl']);
  if (pd.closedToDeparture) tags.push(['CTD', 'cl']);
  if (pd.minLos > 1) tags.push([`MIN${pd.minLos}`, '']);
  if (pd.maxLos) tags.push([`MAX${pd.maxLos}`, '']);
  if (pd.minStayThrough > 1) tags.push([`THR${pd.minStayThrough}`, '']);
  if (pd.minAdvanceDays > 0) tags.push([`ADV${pd.minAdvanceDays}`, '']);
  if (pd.extraAdultMinor) tags.push(['+AD', '']);
  return h('button', { type: 'button', class: 'pcell', 'aria-label': `${plan.name} restrictions ${fmtLong(pd.date)}: ${tags.map((t) => t[0]).join(', ') || 'none'}`, onclick: () => openUpdate({ rt, plan, date: pd.date }) },
    tags.length ? h('span', { class: 'rtags' }, tags.map(([t, c]) => h('span', { class: `rtag ${c}` }, t))) : h('span', { class: 'muted' }, '-'));
}

// ---------------------------------------------------------------- update dialog (single + bulk)
const uForm = $('#update-form');
$('#weekday-chips').replaceChildren(...WEEKDAYS.map((d, i) =>
  h('button', { type: 'button', class: 'chip', 'aria-pressed': 'true', dataset: { dow: String(i) }, onclick: (e) => {
    const c = e.currentTarget;
    c.setAttribute('aria-pressed', String(c.getAttribute('aria-pressed') !== 'true'));
  } }, d)));
$('#bulk-btn').addEventListener('click', () => openUpdate({}));

/** ctx: {} for bulk, {rt, date} from a room cell, {rt, plan, date} from a plan cell. */
function openUpdate(ctx) {
  if (!state.calendar) return;
  state.update = ctx;
  uForm.reset();
  document.querySelectorAll('#weekday-chips .chip').forEach((c) => c.setAttribute('aria-pressed', 'true'));
  const single = !!ctx.rt;
  const date = ctx.date ?? (state.calStart > state.hotel.today ? state.calStart : state.hotel.today);
  uForm.startDate.value = date;
  uForm.endDate.value = single ? date : addDays(date, 6);
  $('#update-title').textContent = single ? (ctx.plan ? `${ctx.rt.name}: ${ctx.plan.name}` : ctx.rt.name) : 'Bulk update';
  $('#update-sub').textContent = single ? `${fmtLong(date)}. Empty fields stay as they are.` : 'Pick rooms, plans, dates and weekdays. Empty fields stay as they are.';

  // Scope: room types and their plans.
  const scope = state.calendar.roomTypes.map((rt) => {
    const rtOn = !single || rt.id === ctx.rt.id;
    return h('div', { class: 'rt' },
      h('label', { class: 'check' }, h('input', { type: 'checkbox', name: 'rt', value: rt.id, checked: rtOn }), rt.name),
      h('div', { class: 'plans' }, (rt.ratePlans ?? []).map((p) =>
        h('label', { class: 'check' },
          h('input', { type: 'checkbox', name: 'rp', value: p.id, dataset: { rt: rt.id, derived: p.rateMode === 'DERIVED' ? '1' : '', follow: p.followParentRestrictions ? '1' : '' },
            checked: single ? (ctx.plan ? p.id === ctx.plan.id : rt.id === ctx.rt.id && p.isDefault) : p.isDefault && p.rateMode !== 'DERIVED' }),
          `${p.name}${p.rateMode === 'DERIVED' ? ' (auto)' : ''}`))));
  });
  $('#update-scope').replaceChildren(...scope);

  // Current values as placeholders, so the hotelier sees what is there now.
  const stats = $('#update-stats');
  stats.hidden = !single;
  const setPh = (name, v) => { uForm[name].placeholder = v === null || v === undefined || v === '' ? '' : `now ${v}`; };
  for (const n of ['availability', 'price', 'extraAdult', 'extraChild', 'minLos', 'maxLos', 'minStayThrough', 'maxStayThrough', 'minAdvanceDays', 'maxAdvanceDays']) uForm[n].placeholder = '';
  uForm.maxLos.placeholder = uForm.maxStayThrough.placeholder = uForm.maxAdvanceDays.placeholder = '0 = none';
  if (single) {
    const day = ctx.rt.days.find((d) => d.date === date);
    stats.replaceChildren(stat(day.loaded ? day.available : '-', 'left to sell'), stat(day.soldOffline, 'sold offline'), stat(day.soldOnline, 'sold online'), stat(day.held, 'in checkout now'));
    setPh('availability', day.loaded ? day.available : null);
    const plan = ctx.plan ?? (ctx.rt.ratePlans ?? []).find((p) => p.isDefault);
    const pd = plan?.days.find((d) => d.date === date);
    if (pd) {
      setPh('price', pd.priceMinor ? pd.priceMinor / 100 : null);
      setPh('extraAdult', pd.extraAdultMinor ? pd.extraAdultMinor / 100 : 0);
      setPh('extraChild', pd.extraChildMinor ? pd.extraChildMinor / 100 : 0);
      setPh('minLos', pd.minLos);
      setPh('minStayThrough', pd.minStayThrough);
      setPh('minAdvanceDays', pd.minAdvanceDays);
      if (pd.maxLos) setPh('maxLos', pd.maxLos);
      if (pd.maxStayThrough) setPh('maxStayThrough', pd.maxStayThrough);
      if (pd.maxAdvanceDays) setPh('maxAdvanceDays', pd.maxAdvanceDays);
    }
  }
  const editable = canEdit();
  for (const el of uForm.querySelectorAll('input, select')) el.disabled = !editable;
  $('#update-save').hidden = !editable;
  $('#update-sell').hidden = !(single && canSell());
  const note = $('#update-note');
  note.hidden = editable;
  note.textContent = editable ? '' : managed() ? 'Your role can view this but not change it.' : 'This hotel is managed by its channel manager or supplier.';
  $('#update-error').hidden = true;
  $('#update-dialog').showModal();
}

const stat = (value, label) => h('div', { class: 'stat' }, h('b', {}, value), h('span', {}, label));

// Ticking a room type ticks its default plan; unticking clears its plans.
$('#update-scope').addEventListener('change', (e) => {
  if (e.target.name !== 'rt') return;
  for (const p of document.querySelectorAll(`#update-scope input[name=rp][data-rt="${e.target.value}"]`)) {
    if (!e.target.checked) p.checked = false;
  }
});

$('#update-sell').addEventListener('click', () => {
  const { rt, date } = state.update;
  $('#update-dialog').close();
  openBooking({ roomTypeId: rt.id, checkIn: date });
});

$('#update-save').addEventListener('click', async () => {
  const f = uForm;
  const err = $('#update-error');
  err.hidden = true;
  const startDate = f.startDate.value;
  const endDate = f.endDate.value;
  if (!startDate || !endDate || endDate < startDate) return showErr(err, 'Choose a valid date range.');
  if (nightsBetween(startDate, endDate) > 730) return showErr(err, 'At most 2 years at a time.');
  const weekdays = [...document.querySelectorAll('#weekday-chips .chip')].filter((c) => c.getAttribute('aria-pressed') === 'true').map((c) => Number(c.dataset.dow));
  if (!weekdays.length) return showErr(err, 'Pick at least one day of the week.');
  const wd = weekdays.length < 7 ? { weekdays } : {};

  const num = (name, min) => {
    const v = f[name].value.trim();
    if (v === '') return undefined;
    const n = Number(v);
    if (!Number.isInteger(n) || n < min) throw new Error(`${f[name].closest('label').firstChild.textContent.trim()} must be a whole number`);
    return n;
  };
  const tri = (name) => (f[name].value === '' ? undefined : f[name].value === 'true');
  const money = (name, allowZero) => {
    const p = toPaise(f[name].value, allowZero);
    if (Number.isNaN(p)) throw new Error('Enter amounts like 8500 or 8500.50.');
    return p === null ? undefined : p;
  };

  let room, rate;
  try {
    const maxLos = num('maxLos', 0);
    const maxThr = num('maxStayThrough', 0);
    const maxAdv = num('maxAdvanceDays', 0);
    room = { availability: num('availability', 0), stopSell: tri('stopSell') };
    rate = {
      priceMinor: money('price', false),
      extraAdultMinor: money('extraAdult', true),
      extraChildMinor: money('extraChild', true),
      minLos: num('minLos', 1),
      ...(maxLos !== undefined ? { maxLos: maxLos || null } : {}),
      minStayThrough: num('minStayThrough', 1),
      ...(maxThr !== undefined ? { maxStayThrough: maxThr || null } : {}),
      minAdvanceDays: num('minAdvanceDays', 0),
      ...(maxAdv !== undefined ? { maxAdvanceDays: maxAdv || null } : {}),
      closedToArrival: tri('closedToArrival'),
      closedToDeparture: tri('closedToDeparture'),
      stopSell: tri('planStopSell'),
    };
  } catch (ex) {
    return showErr(err, ex.message);
  }
  const clean = (o) => Object.fromEntries(Object.entries(o).filter(([, v]) => v !== undefined));
  room = clean(room);
  rate = clean(rate);
  if (!Object.keys(room).length && !Object.keys(rate).length) return showErr(err, 'Nothing to change: fill in at least one field.');

  const rts = [...document.querySelectorAll('#update-scope input[name=rt]:checked')].map((x) => x.value);
  const plans = [...document.querySelectorAll('#update-scope input[name=rp]:checked')];
  const updates = [];
  if (Object.keys(room).length) {
    if (!rts.length) return showErr(err, 'Tick at least one room type.');
    for (const id of rts) updates.push({ roomTypeId: id, startDate, endDate, ...wd, ...room });
  }
  if (Object.keys(rate).length) {
    if (!plans.length) return showErr(err, 'Tick at least one rate plan for price or restriction changes.');
    const priceish = ['priceMinor', 'extraAdultMinor', 'extraChildMinor'].some((k) => k in rate);
    for (const p of plans) {
      if (p.dataset.derived && priceish) return showErr(err, 'Prices of "auto" plans follow their parent plan. Untick them or change the parent.');
      if (p.dataset.derived && p.dataset.follow) return showErr(err, 'That "auto" plan follows its parent\'s restrictions too. Change the parent instead.');
      updates.push({ roomTypeId: p.dataset.rt, ratePlanId: p.value, startDate, endDate, ...wd, ...rate });
    }
  }
  if (updates.length > 500) return showErr(err, 'Too many combinations at once. Narrow it down.');
  const btn = $('#update-save');
  btn.disabled = true;
  try {
    const r = await api('PUT', `/hotels/${state.hotel.id}/ari`, { updates });
    $('#update-dialog').close();
    const nights = r.inventoryRowsWritten + r.rateRowsWritten;
    toast(`Saved (${nights} night${nights === 1 ? '' : 's'} updated${r.derivedRowsWritten ? `, ${r.derivedRowsWritten} auto prices recalculated` : ''}). Channels are being updated.`);
    await loadCalendar();
  } catch (ex) {
    if (ex.status !== 401) showErr(err, explain(ex));
  } finally {
    btn.disabled = false;
  }
});

// ---------------------------------------------------------------- offline booking
const bkForm = $('#booking-form');
let bkSource = 'WALK_IN';
$('#source-chips').replaceChildren(...SOURCES.map(([code, label]) =>
  h('button', { type: 'button', class: 'chip', 'aria-pressed': String(code === bkSource), dataset: { code }, onclick: () => setSource(code) }, label)));
function setSource(code) {
  bkSource = code;
  document.querySelectorAll('#source-chips .chip').forEach((c) => c.setAttribute('aria-pressed', String(c.dataset.code === code)));
  $('#source-detail-wrap').hidden = !['TRAVEL_AGENT', 'OTHER_OTA', 'OTHER'].includes(code);
}

function openBooking(prefill = {}) {
  if (!state.calendar) return;
  bkForm.reset();
  setSource('WALK_IN');
  bkForm.roomTypeId.replaceChildren(...state.calendar.roomTypes.map((rt) => h('option', { value: rt.id }, rt.name)));
  if (prefill.roomTypeId) bkForm.roomTypeId.value = prefill.roomTypeId;
  const ci = prefill.checkIn && prefill.checkIn >= state.hotel.today ? prefill.checkIn : state.hotel.today;
  bkForm.checkIn.value = ci;
  bkForm.checkOut.value = addDays(ci, 1);
  bkForm.checkIn.min = addDays(state.hotel.today, -1);
  $('#booking-error').hidden = true;
  updateEstimate();
  $('#booking-dialog').showModal();
  bkForm.guestName.focus();
}
for (const b of [$('#new-booking-btn'), $('#new-booking-btn-2')]) b.addEventListener('click', () => openBooking());

bkForm.addEventListener('input', (e) => {
  if (e.target.name === 'checkIn' && bkForm.checkOut.value <= bkForm.checkIn.value) bkForm.checkOut.value = addDays(bkForm.checkIn.value, 1);
  updateEstimate();
});
bkForm.roomTypeId.addEventListener('change', updateEstimate);

function updateEstimate() {
  const out = $('#booking-estimate');
  out.textContent = '';
  const rt = state.calendar?.roomTypes.find((r) => r.id === bkForm.roomTypeId.value);
  const ci = bkForm.checkIn.value;
  const co = bkForm.checkOut.value;
  const rooms = Number(bkForm.rooms.value) || 1;
  if (!rt || !ci || !co || co <= ci) return;
  let total = 0;
  for (let d = ci; d < co; d = addDays(d, 1)) {
    const day = rt.days.find((x) => x.date === d);
    if (!day || !day.priceMinor) return;
    total += day.priceMinor * rooms;
  }
  const n = nightsBetween(ci, co);
  out.textContent = `Listed price: ${inr(total)} for ${n} night${n > 1 ? 's' : ''}`;
}

$('#booking-save').addEventListener('click', async () => {
  const f = bkForm;
  const err = $('#booking-error');
  err.hidden = true;
  if (f.guestName.value.trim().length < 2) return showErr(err, 'Enter the guest name.');
  if (!f.checkIn.value || !f.checkOut.value || f.checkOut.value <= f.checkIn.value) return showErr(err, 'Check-out must be after check-in.');
  const amount = toPaise(f.amount.value, true);
  if (Number.isNaN(amount)) return showErr(err, 'Enter the amount like 17000 or 17000.50, or leave it empty.');
  const body = {
    roomTypeId: f.roomTypeId.value,
    checkIn: f.checkIn.value,
    checkOut: f.checkOut.value,
    rooms: Number(f.rooms.value),
    adults: Number(f.adults.value),
    children: Number(f.children.value || 0),
    source: bkSource,
    guestName: f.guestName.value.trim(),
    ...(f.sourceDetail.value.trim() && !$('#source-detail-wrap').hidden ? { sourceDetail: f.sourceDetail.value.trim() } : {}),
    ...(f.guestPhone.value.trim() ? { guestPhone: f.guestPhone.value.trim() } : {}),
    ...(f.guestEmail.value.trim() ? { guestEmail: f.guestEmail.value.trim() } : {}),
    ...(amount !== null ? { amountMinor: amount } : {}),
    ...(f.notes.value.trim() ? { notes: f.notes.value.trim() } : {}),
  };
  const btn = $('#booking-save');
  btn.disabled = true;
  try {
    const r = await api('POST', `/hotels/${state.hotel.id}/reservations`, body);
    $('#booking-dialog').close();
    toast(`Booked ${r.reference}. Rooms removed from all channels.`);
    await loadCalendar();
    if (currentTab() === 'bookings') loadBookings();
  } catch (ex) {
    if (ex.status !== 401) showErr(err, explain(ex));
  } finally {
    btn.disabled = false;
  }
});

// ---------------------------------------------------------------- bookings
$('#bk-refresh').addEventListener('click', loadBookings);

async function loadBookings() {
  const list = $('#bk-list');
  const from = $('#bk-from').value;
  const to = $('#bk-to').value;
  $('#bk-export').href = `${API}/hotels/${state.hotel.id}/reservations.csv?from=${from}&to=${to}`;
  try {
    const { reservations } = await api('GET', `/hotels/${state.hotel.id}/reservations?from=${from}&to=${to}`);
    const over = reservations.filter((r) => r.overbooked && r.status === 'CONFIRMED');
    const alert = $('#alert-banner');
    alert.hidden = !over.length;
    alert.textContent = over.length ? `${over.length} OTA booking${over.length > 1 ? 's' : ''} arrived for sold-out dates. Move the guest or contact the channel.` : '';
    list.replaceChildren(...(reservations.length ? reservations.map(bookingCard) : [h('div', { class: 'empty' }, 'No bookings in these dates.')]));
  } catch (err) {
    if (err.status !== 401) list.replaceChildren(h('div', { class: 'empty' }, explain(err)));
  }
}

function bookingCard(r) {
  const nights = nightsBetween(r.check_in, r.check_out);
  const editableRow = r.channel !== 'ONLINE';
  const sourceLabel = r.channel === 'ONLINE' ? 'Website' : r.channel === 'OTA' ? (r.source_detail || 'OTA') : (SOURCES.find(([c]) => c === r.source)?.[1] ?? r.source);
  const actions = editableRow && canSell() ? (NEXT_ACTIONS[r.status] ?? []) : [];
  return h('article', { class: 'bk' },
    h('div', { class: 'bk-top' },
      h('span', { class: 'bk-name' }, r.guest_name || 'Guest'),
      h('span', {},
        r.overbooked && r.status === 'CONFIRMED' ? h('span', { class: 'pill NO_SHOW bad' }, 'Overbooked') : null, ' ',
        h('span', { class: `pill ${r.channel === 'ONLINE' ? 'ONLINE' : r.status}` }, r.channel === 'ONLINE' ? 'Paid online' : STATUS_LABEL[r.status])),
    ),
    h('div', { class: 'bk-meta' },
      h('span', {}, `${fmtDate(r.check_in)} to ${fmtDate(r.check_out)} (${nights} night${nights > 1 ? 's' : ''})`),
      h('span', {}, `${r.rooms} x ${r.room_name}`),
      h('span', {}, `${sourceLabel}${r.channel !== 'OTA' && r.source_detail ? `: ${r.source_detail}` : ''}`),
      r.amount_minor !== null ? h('span', {}, inr(Number(r.amount_minor), r.currency)) : null,
      h('span', { class: 'muted' }, r.reference)),
    r.guest_phone ? h('div', { class: 'bk-meta' }, h('a', { href: `tel:${r.guest_phone.replace(/[^+0-9]/g, '')}` }, r.guest_phone)) : null,
    r.notes ? h('div', { class: 'bk-meta' }, r.notes) : null,
    actions.length ? h('div', { class: 'bk-actions' }, actions.map(([to, label, cls]) =>
      h('button', { type: 'button', class: `btn btn-sm ${cls}`, onclick: (e) => changeStatus(r, to, label, e.currentTarget) }, label))) : null);
}

async function changeStatus(r, to, label, btn) {
  const warn = to === 'CANCELLED' || to === 'NO_SHOW' ? ' Unused nights will go back on sale on every channel.' : '';
  if (!window.confirm(`${label}: ${r.guest_name}, ${fmtDate(r.check_in)} to ${fmtDate(r.check_out)}?${warn}`)) return;
  btn.disabled = true;
  try {
    await api('POST', `/hotels/${state.hotel.id}/reservations/${r.id}/status`, { status: to });
    toast(`${r.guest_name}: ${STATUS_LABEL[to]}.`);
    await Promise.all([loadBookings(), loadCalendar()]);
  } catch (err) {
    btn.disabled = false;
    if (err.status !== 401) toast(explain(err), 'error');
  }
}

// ---------------------------------------------------------------- setup
async function loadSetup() {
  const body = $('#setup-body');
  try {
    state.setup = await api('GET', `/hotels/${state.hotel.id}/setup`);
    renderSetup(state.setup);
  } catch (err) {
    if (err.status !== 401) body.replaceChildren(h('div', { class: 'empty' }, explain(err)));
  }
}

function renderSetup(s) {
  const edit = canEdit();
  const settings = h('section', { class: 'card' },
    h('div', { class: 'card-head' },
      h('div', {}, h('h2', {}, 'Selling window'), h('p', { class: 'muted' }, 'Rooms and prices stay open this many days ahead. Every day the window moves forward and new dates copy your latest prices.')),
    ),
    edit
      ? h('div', { class: 'row' },
          h('label', {}, 'Days open ahead (0 = off, max 730)', h('input', { id: 'horizon-input', type: 'number', min: '0', max: '730', value: String(s.hotel.openHorizonDays), disabled: role() < RANK.owner })),
          h('div', { class: 'toolbar-actions' },
            role() >= RANK.owner ? h('button', { type: 'button', class: 'btn btn-primary', onclick: saveHorizon }, 'Save') : null,
            h('button', { type: 'button', class: 'btn btn-danger', onclick: resetAvail }, 'Reset availability')))
      : h('p', { class: 'muted' }, managed() ? 'Managers and owners can change setup.' : 'This hotel is set up in its channel manager.'),
    edit ? h('p', { class: 'muted small' }, 'Reset availability recalculates rooms left for every future night as total rooms minus all bookings. Use it if numbers ever look wrong.') : null,
  );

  const rooms = s.roomTypes.map((rt) => h('section', { class: 'card' },
    h('div', { class: 'card-head' },
      h('div', {}, h('h2', {}, rt.name, rt.isActive ? null : h('span', { class: 'muted small' }, ' (inactive)')),
        h('p', { class: 'muted' }, `${rt.totalRooms} room${rt.totalRooms === 1 ? '' : 's'} · price includes ${rt.baseOccupancy} · up to ${rt.maxAdults} adults, ${rt.maxChildren} children, ${rt.maxInfants} infants`)),
      edit ? h('div', { class: 'toolbar-actions' },
        h('button', { type: 'button', class: 'btn btn-ghost btn-sm', onclick: () => openRoom(rt) }, 'Edit'),
        h('button', { type: 'button', class: 'btn btn-ghost btn-sm', onclick: () => openPlan(rt, null) }, '+ Rate plan')) : null),
    h('ul', { class: 'plan-list' }, rt.ratePlans.map((p) => h('li', {},
      h('div', {},
        h('div', {}, h('b', {}, p.name), p.isDefault ? h('span', { class: 'muted small' }, '  default') : null),
        h('div', { class: 'meta' }, `${MEALS[p.mealPlan]}${p.rateMode === 'DERIVED' ? ` · follows ${p.parentName} ${p.deriveValue >= 0 ? '+' : ''}${p.deriveType === 'PERCENT' ? `${p.deriveValue}%` : inr(p.deriveValue)}${p.followParentRestrictions ? ', same restrictions' : ', own restrictions'}` : ' · own prices'}`)),
      edit ? h('button', { type: 'button', class: 'btn btn-ghost btn-sm', onclick: () => openPlan(rt, p) }, 'Edit') : null))),
  ));

  const add = edit ? h('button', { type: 'button', class: 'btn btn-accent', onclick: () => openRoom(null) }, '+ Add room type') : null;
  $('#setup-body').replaceChildren(settings, ...rooms, ...(add ? [h('div', {}, add)] : []));
}

async function saveHorizon() {
  const v = Number($('#horizon-input').value);
  if (!Number.isInteger(v) || v < 0 || v > 730) return toast('Days must be 0 to 730.', 'error');
  try {
    await api('PUT', `/hotels/${state.hotel.id}/settings`, { openHorizonDays: v });
    toast(v ? `Open for sale ${v} days ahead.` : 'Rolling window turned off.');
    loadCalendar();
  } catch (err) {
    if (err.status !== 401) toast(explain(err), 'error');
  }
}

async function resetAvail() {
  if (!window.confirm('Recalculate rooms left for all future nights from total rooms minus bookings? Channels will be updated.')) return;
  try {
    const r = await api('POST', `/hotels/${state.hotel.id}/reset-availability`, {});
    toast(r.nightsCorrected ? `Corrected ${r.nightsCorrected} night(s).` : 'Everything already matched.');
    loadCalendar();
  } catch (err) {
    if (err.status !== 401) toast(explain(err), 'error');
  }
}

// Room type dialog
const roomForm = $('#room-form');
let roomEditing = null;
function openRoom(rt) {
  roomEditing = rt;
  roomForm.reset();
  $('#room-title').textContent = rt ? `Edit ${rt.name}` : 'New room type';
  $('#room-create-only').hidden = !!rt;
  $('#room-active-wrap').hidden = !rt;
  const v = rt ?? { name: '', totalRooms: 1, baseOccupancy: 2, maxAdults: 2, maxChildren: 1, maxInfants: 1, isActive: true };
  roomForm.name.value = v.name;
  roomForm.totalRooms.value = v.totalRooms;
  roomForm.baseOccupancy.value = v.baseOccupancy;
  roomForm.maxAdults.value = v.maxAdults;
  roomForm.maxChildren.value = v.maxChildren;
  roomForm.maxInfants.value = v.maxInfants;
  roomForm.isActive.checked = v.isActive;
  const note = $('#room-note');
  note.hidden = !rt;
  note.textContent = rt ? 'Changing total rooms adds or removes that many rooms on every future night. Rooms already sold stay sold.' : '';
  $('#room-error').hidden = true;
  $('#room-dialog').showModal();
}

$('#room-save').addEventListener('click', async () => {
  const f = roomForm;
  const err = $('#room-error');
  err.hidden = true;
  const ints = ['totalRooms', 'baseOccupancy', 'maxAdults', 'maxChildren', 'maxInfants'].map((n) => [n, Number(f[n].value)]);
  if (ints.some(([, v]) => !Number.isInteger(v) || v < 0)) return showErr(err, 'Use whole numbers.');
  const body = { name: f.name.value.trim(), ...Object.fromEntries(ints) };
  if (body.name.length < 2) return showErr(err, 'Enter a name.');
  if (roomEditing) body.isActive = f.isActive.checked;
  else {
    const p = toPaise(f.price.value);
    if (Number.isNaN(p)) return showErr(err, 'Enter the price like 6500.');
    Object.assign(body, { ratePlanName: f.ratePlanName.value.trim() || 'Room only', mealPlan: f.mealPlan.value, ...(p ? { priceMinor: p } : {}) });
  }
  const btn = $('#room-save');
  btn.disabled = true;
  try {
    if (roomEditing) {
      const r = await api('PUT', `/hotels/${state.hotel.id}/room-types/${roomEditing.id}`, body);
      toast(r.shiftedBy ? `Saved. ${r.shiftedBy > 0 ? 'Added' : 'Removed'} ${Math.abs(r.shiftedBy)} room(s) on every future night.` : 'Saved.');
    } else {
      await api('POST', `/hotels/${state.hotel.id}/room-types`, body);
      toast(`${body.name} is open for sale.`);
    }
    $('#room-dialog').close();
    await Promise.all([loadSetup(), loadCalendar()]);
  } catch (ex) {
    if (ex.status !== 401) showErr(err, explain(ex));
  } finally {
    btn.disabled = false;
  }
});

// Rate plan dialog
const planForm = $('#plan-form');
let planCtx = null;
let planMode = 'MANUAL';
function setPlanMode(mode) {
  planMode = mode;
  document.querySelectorAll('#plan-form [data-mode]').forEach((c) => c.setAttribute('aria-pressed', String(c.dataset.mode === mode)));
  $('#plan-derived').hidden = mode !== 'DERIVED';
}
document.querySelectorAll('#plan-form [data-mode]').forEach((c) => c.addEventListener('click', () => setPlanMode(c.dataset.mode)));

function openPlan(rt, plan) {
  planCtx = { rt, plan };
  planForm.reset();
  $('#plan-title').textContent = plan ? `Edit ${plan.name}` : 'New rate plan';
  $('#plan-sub').textContent = rt.name;
  // Parents: manual plans of this hotel (not the plan itself).
  const parents = state.setup.roomTypes.flatMap((r) => r.ratePlans.filter((p) => p.rateMode === 'MANUAL' && p.id !== plan?.id).map((p) => ({ ...p, rtName: r.name })));
  planForm.parentRatePlanId.replaceChildren(...parents.map((p) => h('option', { value: p.id }, `${p.rtName}: ${p.name}`)));
  planForm.name.value = plan?.name ?? '';
  planForm.mealPlan.value = plan?.mealPlan ?? 'CP';
  planForm.isDefault.checked = !!plan?.isDefault;
  setPlanMode(plan?.rateMode ?? 'MANUAL');
  if (plan?.rateMode === 'DERIVED') {
    planForm.parentRatePlanId.value = plan.parentRatePlanId;
    planForm.deriveType.value = plan.deriveType;
    planForm.deriveValue.value = plan.deriveType === 'PERCENT' ? String(plan.deriveValue) : String(plan.deriveValue / 100);
    planForm.followParentRestrictions.checked = plan.followParentRestrictions;
  } else {
    const def = rt.ratePlans.find((p) => p.isDefault && p.rateMode === 'MANUAL');
    if (def) planForm.parentRatePlanId.value = def.id;
  }
  $('#plan-error').hidden = true;
  $('#plan-dialog').showModal();
}

$('#plan-save').addEventListener('click', async () => {
  const f = planForm;
  const err = $('#plan-error');
  err.hidden = true;
  const body = { roomTypeId: planCtx.rt.id, name: f.name.value.trim(), mealPlan: f.mealPlan.value, rateMode: planMode, isDefault: f.isDefault.checked };
  if (body.name.length < 2) return showErr(err, 'Enter a name.');
  if (planMode === 'DERIVED') {
    const raw = f.deriveValue.value.trim().replace(/[,\s]/g, '');
    if (!/^[+-]?\d+(\.\d{1,2})?$/.test(raw)) return showErr(err, 'Enter the adjustment like 15, -10 or -500.');
    const n = Number(raw);
    Object.assign(body, {
      parentRatePlanId: f.parentRatePlanId.value,
      deriveType: f.deriveType.value,
      deriveValue: f.deriveType.value === 'PERCENT' ? n : Math.round(n * 100),
      followParentRestrictions: f.followParentRestrictions.checked,
    });
    if (!body.parentRatePlanId) return showErr(err, 'Choose the plan to follow.');
  }
  const btn = $('#plan-save');
  btn.disabled = true;
  try {
    if (planCtx.plan) await api('PUT', `/hotels/${state.hotel.id}/rate-plans/${planCtx.plan.id}`, body);
    else await api('POST', `/hotels/${state.hotel.id}/rate-plans`, body);
    $('#plan-dialog').close();
    toast(planMode === 'DERIVED' ? 'Saved. Prices calculated for every date.' : 'Saved. Set its prices from the calendar.');
    await Promise.all([loadSetup(), loadCalendar()]);
  } catch (ex) {
    if (ex.status !== 401) showErr(err, explain(ex));
  } finally {
    btn.disabled = false;
  }
});

// ---------------------------------------------------------------- channels
async function loadChannels() {
  const body = $('#channels-body');
  try {
    const [c, cx] = await Promise.all([
      api('GET', `/hotels/${state.hotel.id}/channels`),
      api('GET', `/hotels/${state.hotel.id}/channels/channex`),
    ]);
    renderChannels(c, cx);
  } catch (err) {
    if (err.status !== 401) body.replaceChildren(h('div', { class: 'empty' }, explain(err)));
  }
}

function renderChannels(c, cx) {
  const owner = role() >= RANK.owner;
  const cm = c.qloappsChannelManager;
  const actions = h('section', { class: 'card' },
    h('div', { class: 'card-head' },
      h('div', {}, h('h2', {}, 'Sync'), h('p', { class: 'muted' }, 'Every change is sent to connected channels within seconds. Use full sync after connecting a new channel.')),
      h('div', { class: 'toolbar-actions' },
        h('button', { type: 'button', class: 'btn btn-primary', onclick: doFullSync }, 'Sync all channels'),
        h('button', { type: 'button', class: 'btn btn-ghost', onclick: doRetry }, 'Retry failed'))));

  const cmCard = h('section', { class: 'card' },
    h('div', { class: 'card-head' },
      h('div', {}, h('h2', {}, 'QloApps Channel Manager'),
        h('p', { class: 'muted' }, 'Reaches Booking.com, Expedia, MakeMyTrip/Goibibo, Agoda, Airbnb, Yatra, Hostelworld, Trip.com and more.')),
      cm ? h('span', { id: 'cm-status', class: cm.failed ? 'bad' : cm.lastPushError ? 'bad' : 'ok' }, cm.failed || cm.lastPushError ? 'Needs attention' : 'Connected') : h('span', { id: 'cm-status', class: 'muted' }, 'Not connected')),
    cm ? h('div', { class: 'kv' },
      h('div', {}, h('b', {}, fmtWhen(cm.lastPushAt)), h('span', {}, 'last update sent')),
      h('div', {}, h('b', {}, cm.pending), h('span', {}, 'waiting to send')),
      h('div', {}, h('b', { class: cm.failed ? 'bad' : '' }, cm.failed), h('span', {}, 'failed')),
      h('div', {}, h('b', {}, cm.hasCredentials ? 'Set' : 'Missing'), h('span', {}, 'API credentials'))) : null,
    cm?.lastPushError ? h('p', { class: 'form-error' }, `Last error: ${cm.lastPushError}`) : null,
    owner ? cmConnectForm(!!cm) : h('p', { class: 'muted small' }, 'The hotel owner can connect or change this.'));

  const others = c.channels.length
    ? c.channels.map((ch) => h('section', { class: 'card' },
        h('div', { class: 'card-head' },
          h('div', {}, h('h2', {}, ch.code), h('p', { class: 'muted' }, `${ch.endpointHost} · ${ch.events.join(', ')}`)),
          h('span', { class: ch.failed ? 'bad' : 'ok' }, !ch.active ? 'Paused' : ch.failed ? 'Needs attention' : 'Healthy')),
        h('div', { class: 'kv' },
          h('div', {}, h('b', {}, fmtWhen(ch.lastSuccessAt)), h('span', {}, 'last delivered')),
          h('div', {}, h('b', {}, ch.pending), h('span', {}, 'waiting')),
          h('div', {}, h('b', { class: ch.failed ? 'bad' : '' }, ch.failed), h('span', {}, 'failed'))),
        ch.lastError ? h('p', { class: 'muted small' }, `Last error: ${ch.lastError}`) : null))
    : [h('section', { class: 'card' }, h('p', { class: 'muted' }, 'No direct partner channels yet. Partner websites and channel managers like STAAH or AxisRooms are connected by your administrator.'))];

  $('#channels-body').replaceChildren(actions, channexCard(cx), cmCard, ...others);
}

// ---- Channex: direct connection to the OTAs ----------------------------------
const CX_OTAS = 'Booking.com, Expedia, Agoda, MakeMyTrip/Goibibo, Airbnb, Trip.com, Despegar, Yatra, Hostelworld, HyperGuest, Google Hotels and 70+ more.';

function channexCard(cx) {
  const owner = role() >= RANK.owner;
  const hid = state.hotel.id;
  const attention = cx.connected && (cx.consecutiveFailures > 0 || cx.failedBookings.length > 0 || cx.unmapped.rooms + cx.unmapped.ratePlans > 0);
  const status = !cx.connected
    ? h('span', { class: 'muted' }, 'Not connected')
    : h('span', { class: attention ? 'bad' : 'ok' }, attention ? 'Needs attention' : 'Connected');
  const head = h('div', { class: 'card-head' },
    h('div', {}, h('h2', {}, 'Channex ', h('span', { class: 'badge' }, 'Recommended')),
      h('p', { class: 'muted' }, `Direct to ${CX_OTAS}`)),
    status);

  if (!cx.configured) {
    return h('section', { class: 'card' }, head,
      h('p', { class: 'muted small' }, 'Not set up on this server yet. Your administrator adds the Channex API key (CHANNEX_API_KEY).'));
  }

  if (!cx.connected) {
    if (!owner) return h('section', { class: 'card' }, head, h('p', { class: 'muted small' }, 'The hotel owner can connect this.'));
    const out = h('div', {});
    const link = h('form', { class: 'stack-sm', novalidate: true },
      h('label', {}, 'Already have a Channex property? Paste its ID',
        h('input', { name: 'propertyId', placeholder: 'e.g. 716305c4-561a-4561-a187-7f5b8aeb5920', autocomplete: 'off', spellcheck: 'false' })),
      h('div', { class: 'toolbar-actions' },
        h('button', { type: 'submit', class: 'btn btn-ghost' }, 'Link existing property')));
    const connect = async (body, btn) => {
      btn.disabled = true;
      try {
        await api('POST', `/hotels/${hid}/channels/channex`, body);
        toast('Connected to Channex. Next: map your rooms and rates.');
        loadChannels();
      } catch (err) {
        if (err.status !== 401) out.replaceChildren(h('p', { class: 'form-error' }, explain(err)));
      } finally {
        btn.disabled = false;
      }
    };
    link.addEventListener('submit', (e) => {
      e.preventDefault();
      const id = link.propertyId.value.trim();
      if (!/^[0-9a-f-]{36}$/i.test(id)) return out.replaceChildren(h('p', { class: 'form-error' }, 'That does not look like a Channex property ID.'));
      connect({ mode: 'link', propertyId: id }, link.querySelector('button'));
    });
    const createBtn = h('button', { type: 'button', class: 'btn btn-primary' }, 'Create Channex property');
    createBtn.addEventListener('click', () => connect({ mode: 'create' }, createBtn));
    return h('section', { class: 'card' }, head,
      h('p', { class: 'muted small' }, 'One connection for every OTA. Rooms, prices and restrictions go out within seconds of any change here, and OTA bookings come straight into your calendar.'),
      h('div', { class: 'toolbar-actions' }, createBtn),
      link, out);
  }

  const unmapped = cx.unmapped.rooms + cx.unmapped.ratePlans;
  const busy = async (btn, fn) => {
    btn.disabled = true;
    try {
      await fn();
    } catch (err) {
      if (err.status !== 401) toast(explain(err), 'error');
    } finally {
      btn.disabled = false;
    }
  };
  const btn = (label, cls, fn) => {
    const b = h('button', { type: 'button', class: `btn ${cls}` }, label);
    b.addEventListener('click', () => busy(b, fn));
    return b;
  };

  const createMissing = btn('Create missing in Channex', 'btn-primary', async () => {
    const r = await api('POST', `/hotels/${hid}/channels/channex/create-missing`, {});
    toast(r.roomTypes + r.ratePlans ? `Created ${r.roomTypes} room type(s) and ${r.ratePlans} rate plan(s) in Channex.` : 'Everything is already mapped.');
    loadChannels();
  });
  const fullSync = btn('Full sync to Channex', 'btn-primary', async () => {
    const r = await api('POST', `/hotels/${hid}/channels/channex/full-sync`, {});
    toast(`Sending ${r.days} days of rooms, prices and restrictions.`);
    setTimeout(loadChannels, 2500);
  });
  const openOtas = h('button', { type: 'button', class: 'btn btn-primary' }, 'Connect OTAs in Channex');
  openOtas.addEventListener('click', () => busy(openOtas, async () => {
    // Open the tab now (inside the click) so pop-up blockers allow it, then point it at the one-time link.
    const w = window.open('', '_blank');
    try {
      const r = await api('POST', `/hotels/${hid}/channels/channex/ota-link`, {});
      if (w) {
        w.opener = null;
        w.location.href = r.url;
      } else {
        window.location.href = r.url;
      }
    } catch (err) {
      if (w) w.close();
      throw err;
    }
  }));

  const step = (n, done, title, text, ...actions) => h('li', { class: 'cx-step' + (done ? ' done' : '') },
    h('div', { class: 'cx-num', 'aria-hidden': 'true' }, done ? '\u2713' : String(n)),
    h('div', { class: 'stack-xs' }, h('b', {}, title), h('span', { class: 'muted small' }, text),
      actions.length ? h('div', { class: 'toolbar-actions' }, ...actions) : null));

  const mappingBox = h('div', { id: 'cx-mapping' });
  const editMapping = btn(unmapped ? 'Map manually' : 'Edit mapping', 'btn-ghost', () => openChannexMapping(cx, mappingBox));

  const steps = h('ol', { class: 'cx-steps' },
    step(1, unmapped === 0, 'Map rooms and rates',
      unmapped ? `${unmapped} room type(s) or rate plan(s) not linked to Channex yet.` : 'Every room type and rate plan is linked.',
      ...(owner ? [unmapped ? createMissing : null, editMapping].filter(Boolean) : [])),
    step(2, Boolean(cx.lastFullSyncAt), 'Send everything once',
      cx.lastFullSyncAt ? `Last full sync ${fmtWhen(cx.lastFullSyncAt)}. After that only changes are sent.` : 'Sends 500 days of rooms, prices and restrictions in two calls.',
      fullSync),
    step(3, false, 'Connect your OTAs',
      'Opens Channex for this property. Pick Booking.com, Expedia, Agoda, MakeMyTrip and others, sign in to each and map rooms. Link expires in 15 minutes.',
      ...(owner ? [openOtas] : [])));

  const kv = h('div', { class: 'kv' },
    h('div', {}, h('b', {}, fmtWhen(cx.lastPushAt)), h('span', {}, 'last update sent')),
    h('div', {}, h('b', {}, cx.pendingChanges), h('span', {}, 'changes waiting')),
    h('div', {}, h('b', { class: cx.consecutiveFailures ? 'bad' : '' }, cx.consecutiveFailures), h('span', {}, 'failed attempts in a row')),
    h('div', {}, h('b', { class: cx.failedBookings.length ? 'bad' : '' }, cx.failedBookings.length), h('span', {}, 'bookings stuck')));

  const problems = [];
  if (cx.lastPushError) problems.push(h('p', { class: 'form-error' }, `Last error: ${cx.lastPushError}. Retrying automatically.`));
  if (Array.isArray(cx.lastWarnings) && cx.lastWarnings.length) {
    problems.push(h('p', { class: 'muted small' }, `Channex skipped ${cx.lastWarnings.length} value(s) in the last update. Check prices and restrictions on those dates.`));
  }
  let stuck = null;
  if (cx.failedBookings.length) {
    const retry = btn('Retry bookings', 'btn-ghost', async () => {
      const r = await api('POST', `/hotels/${hid}/channels/channex/retry-bookings`, {});
      toast(r.stillFailed ? `${r.stillFailed} booking(s) still need attention.` : 'All bookings are in.');
      loadChannels();
    });
    stuck = h('div', { class: 'stack-sm' },
      h('p', { class: 'bad' }, 'OTA bookings that could not be added. Fix the mapping, then retry. Channex keeps them until we confirm.'),
      h('ul', { class: 'cx-list' }, ...cx.failedBookings.map((f) => h('li', {},
        h('b', {}, `${f.ota_name || 'OTA'} (${f.status})`), ' ', h('span', { class: 'muted small' }, `${f.error} · ${fmtWhen(f.received_at)}`)))),
      h('div', { class: 'toolbar-actions' }, retry));
  }
  const recent = cx.recentBookings.length
    ? h('details', { class: 'cx-recent' }, h('summary', {}, `Recent OTA bookings (${cx.recentBookings.length})`),
        h('ul', { class: 'cx-list' }, ...cx.recentBookings.map((b) => h('li', {},
          h('b', {}, b.ota_name || 'OTA'), ' ', h('span', { class: 'muted small' }, `${b.status}: ${b.result} · ${fmtWhen(b.applied_at)}${b.acked_at ? '' : ' · confirming'}`)))))
    : null;

  const disconnect = owner
    ? btn('Disconnect', 'btn-danger', async () => {
        if (!window.confirm('Stop sending updates to Channex for this hotel? OTA connections stay set up in Channex.')) return;
        await api('DELETE', `/hotels/${hid}/channels/channex`);
        toast('Disconnected from Channex.');
        loadChannels();
      })
    : null;

  return h('section', { class: 'card' }, head, steps, kv, ...problems, stuck, mappingBox, recent,
    h('p', { class: 'muted small' }, `Channex property ${cx.propertyId} on ${cx.server}. Not sent to Channex (no such field there): days-before-arrival rules and extra adult/child prices; we still apply them on your own website.`),
    disconnect ? h('div', { class: 'toolbar-actions' }, disconnect) : null);
}

async function openChannexMapping(cx, box) {
  const hid = state.hotel.id;
  box.replaceChildren(h('p', { class: 'muted small' }, 'Loading Channex rooms and rates...'));
  const catalog = await api('GET', `/hotels/${hid}/channels/channex/catalog`);
  const opt = (items, selected) => [h('option', { value: '' }, 'Not linked'),
    ...items.map((i) => h('option', { value: i.id, selected: i.id === selected ? true : undefined }, i.title))];
  const form = h('form', { class: 'stack-sm', novalidate: true });
  for (const rt of cx.mapping) {
    const roomSel = h('select', { name: `room:${rt.roomTypeId}`, 'aria-label': `Channex room type for ${rt.name}` }, ...opt(catalog.roomTypes, rt.channexRoomTypeId));
    const planRows = rt.ratePlans.map((p) => {
      const sel = h('select', { name: `rate:${p.id}`, 'aria-label': `Channex rate plan for ${p.name}` });
      const fill = () => {
        const roomId = roomSel.value;
        const current = sel.value || p.channexRatePlanId;
        sel.replaceChildren(...opt(catalog.ratePlans.filter((r) => !roomId || !r.roomTypeId || r.roomTypeId === roomId), current));
        sel.disabled = !roomId;
      };
      fill();
      roomSel.addEventListener('change', fill);
      return h('label', { class: 'cx-map-row sub' }, h('span', {}, p.name, p.rateMode === 'DERIVED' ? h('span', { class: 'muted small' }, ' (derived, final price sent)') : null), sel);
    });
    form.append(h('div', { class: 'cx-map' }, h('label', { class: 'cx-map-row' }, h('b', {}, rt.name), roomSel), ...planRows));
  }
  const err = h('p', { class: 'form-error', hidden: true });
  form.append(err, h('div', { class: 'toolbar-actions' },
    h('button', { type: 'button', class: 'btn btn-ghost', onclick: () => box.replaceChildren() }, 'Close'),
    h('button', { type: 'submit', class: 'btn btn-primary' }, 'Save mapping')));
  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    const rooms = [];
    const ratePlans = [];
    for (const el of form.querySelectorAll('select')) {
      const [kind, id] = el.name.split(':');
      if (kind === 'room') rooms.push({ roomTypeId: id, channexRoomTypeId: el.value || null });
      else ratePlans.push({ ratePlanId: id, channexRatePlanId: el.disabled ? null : el.value || null });
    }
    try {
      const r = await api('PUT', `/hotels/${hid}/channels/channex/mapping`, { rooms, ratePlans });
      toast(r.changed ? 'Mapping saved. Linked rooms and rates are being sent to Channex.' : 'No changes.');
      loadChannels();
    } catch (e2) {
      if (e2.status !== 401) showErr(err, explain(e2));
    }
  });
  box.replaceChildren(h('h3', {}, 'Link to Channex'), form);
}

function cmConnectForm(connected) {
  const form = h('form', { class: 'stack-sm', novalidate: true },
    h('p', { class: 'muted small' }, connected ? 'Update the API credentials from your Channel Manager account (Account settings).' : 'In your Channel Manager: Account settings > generate API credentials, then paste them here.'),
    h('div', { class: 'row' },
      h('label', {}, 'Client ID', h('input', { name: 'clientId', autocomplete: 'off', required: true })),
      h('label', {}, 'Client secret', h('input', { name: 'clientSecret', type: 'password', autocomplete: 'off', required: true }))),
    h('div', { class: 'toolbar-actions' },
      connected ? h('button', { type: 'button', class: 'btn btn-danger', onclick: disconnectCm }, 'Disconnect') : null,
      h('button', { type: 'submit', class: 'btn btn-primary' }, connected ? 'Update credentials' : 'Connect')),
    h('div', { id: 'cm-result' }));
  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    const out = form.querySelector('#cm-result');
    try {
      const r = await api('POST', `/hotels/${state.hotel.id}/channels/qloapps`, { clientId: form.clientId.value.trim(), clientSecret: form.clientSecret.value.trim() });
      form.clientSecret.value = '';
      const status = document.getElementById('cm-status');
      if (status) {
        status.textContent = 'Connected';
        status.className = 'ok';
      }
      out.replaceChildren(r.webserviceKey
        ? h('div', { class: 'stack-sm' },
            h('p', { class: 'ok' }, 'Connected. Finish in your Channel Manager under PMS > General Settings:'),
            h('ol', { class: 'steps' },
              h('li', {}, 'Webservice URL:', h('div', { class: 'codebox' }, r.webserviceUrl)),
              h('li', {}, 'Webservice key (shown only now, copy it):', h('div', { class: 'codebox' }, r.webserviceKey)),
              h('li', {}, 'PMS timezone: Asia/Kolkata, then Test Connection and Submit.'),
              h('li', {}, 'Map properties and room types, connect channels, then press "Sync all channels" here.')))
        : h('p', { class: 'ok' }, 'Credentials updated. Your webservice key is unchanged.'));
      toast('Channel manager connected.');
    } catch (err) {
      if (err.status !== 401) out.replaceChildren(h('p', { class: 'form-error' }, explain(err)));
    }
  });
  return form;
}

async function disconnectCm() {
  if (!window.confirm('Stop sending updates to the QloApps Channel Manager for this hotel?')) return;
  try {
    await api('DELETE', `/hotels/${state.hotel.id}/channels/qloapps`);
    toast('Disconnected.');
    loadChannels();
  } catch (err) {
    if (err.status !== 401) toast(explain(err), 'error');
  }
}

async function doFullSync() {
  try {
    const r = await api('POST', `/hotels/${state.hotel.id}/channels/sync`, {});
    toast(r.channelsQueued ? `Full sync queued to ${r.channelsQueued} channel(s).` : 'No channels connected yet.');
    setTimeout(loadChannels, 1500);
  } catch (err) {
    if (err.status !== 401) toast(explain(err), 'error');
  }
}

async function doRetry() {
  try {
    const r = await api('POST', `/hotels/${state.hotel.id}/channels/retry`, {});
    toast(r.retried ? `Retrying ${r.retried} update(s).` : 'Nothing has failed.');
    setTimeout(loadChannels, 1500);
  } catch (err) {
    if (err.status !== 401) toast(explain(err), 'error');
  }
}

// ---------------------------------------------------------------- activity
async function loadActivity() {
  const list = $('#activity-list');
  if (role() < RANK.manager) {
    list.replaceChildren(h('li', {}, 'The activity log is visible to managers and owners.'));
    return;
  }
  try {
    const { activity } = await api('GET', `/hotels/${state.hotel.id}/activity?limit=100`);
    if (!activity.length) return list.replaceChildren(h('li', {}, 'No changes yet.'));
    list.replaceChildren(...activity.map((a) => h('li', { class: a.action },
      h('div', {}, a.summary),
      h('div', { class: 'when' }, `${a.user_name ?? 'System'} · ${fmtWhen(a.created_at)}`))));
  } catch (err) {
    if (err.status !== 401) list.replaceChildren(h('li', {}, explain(err)));
  }
}

boot();
