// Hotel Extranet web app. Plain ES modules, no build step.
// Security: every piece of server data is written with textContent (never innerHTML),
// and every request carries X-Extranet: 1 (CSRF guard; the session cookie is HttpOnly).

const API = '/api/v1/hotelier';
const DAYS = 14;
const SOURCES = [
  ['WALK_IN', 'Walk-in'],
  ['PHONE', 'Phone'],
  ['WHATSAPP', 'WhatsApp'],
  ['TRAVEL_AGENT', 'Travel agent'],
  ['OTHER_OTA', 'Other OTA'],
  ['OTHER', 'Other'],
];
const STATUS_LABEL = {
  CONFIRMED: 'Confirmed', CHECKED_IN: 'Checked in', CHECKED_OUT: 'Checked out', CANCELLED: 'Cancelled', NO_SHOW: 'No-show',
};
const NEXT_ACTIONS = {
  CONFIRMED: [['CHECKED_IN', 'Check in', 'btn-primary'], ['NO_SHOW', 'No-show', 'btn-ghost'], ['CANCELLED', 'Cancel', 'btn-danger']],
  CHECKED_IN: [['CHECKED_OUT', 'Check out', 'btn-primary']],
};
const RANK = { frontdesk: 1, manager: 2, owner: 3 };

const state = { user: null, hotels: [], hotel: null, calStart: null, calendar: null, editing: null };

// ---------------------------------------------------------------- utilities
const $ = (sel) => document.querySelector(sel);

/** Tiny DOM builder: h('div', { class: 'x', onclick }, 'text', child) */
function h(tag, attrs = {}, ...children) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (v === undefined || v === null || v === false) continue;
    if (k.startsWith('on') && typeof v === 'function') el.addEventListener(k.slice(2), v);
    else if (k === 'class') el.className = v;
    else if (k === 'dataset') Object.assign(el.dataset, v);
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
const inr = (minor, currency = 'INR') =>
  minor === null || minor === undefined ? '' : new Intl.NumberFormat('en-IN', { style: 'currency', currency, maximumFractionDigits: minor % 100 ? 2 : 0 }).format(minor / 100);
const inrShort = (minor) => (minor === null ? '' : minor >= 100000 ? `${(minor / 100000).toFixed(minor % 100000 ? 1 : 0)}k` : String(Math.round(minor / 100)));

/** "8,500.50" -> 850050 paise, exactly (no float math). Null for blank, NaN for junk. */
function toPaise(text) {
  const s = String(text ?? '').replace(/[,\s]/g, '').replace(/^(Rs\.?|INR)/i, '');
  if (s === '') return null;
  if (!/^\d+(\.\d{1,2})?$/.test(s)) return NaN;
  const [whole, frac = ''] = s.split('.');
  return Number(whole) * 100 + Number((frac + '00').slice(0, 2));
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

/** Human message for an API error, with the specifics the hotelier needs. */
function explain(err) {
  if (err.code === 'SOLD_OUT' && err.details?.nights) {
    const parts = err.details.nights.map((n) => (n.loaded === false ? `${fmtDate(n.date)} (no rooms set)` : `${fmtDate(n.date)} (${n.available} left)`));
    return `Not enough rooms: ${parts.join(', ')}.`;
  }
  if (err.code === 'INVENTORY_BUSY') return 'Someone is booking these dates right now. Try again in a moment.';
  if (err.code === 'VALIDATION_ERROR' && err.details?.issues?.fieldErrors) {
    const f = Object.entries(err.details.issues.fieldErrors)[0];
    if (f) return `${f[0]}: ${f[1][0]}`;
  }
  return err.message;
}

const canEdit = () => state.hotel && state.hotel.source === 'EXTRANET' && RANK[state.hotel.role] >= RANK.manager;
const canSell = () => state.hotel && state.hotel.source === 'EXTRANET';

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
    err.textContent = ex.message;
    err.hidden = false;
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
    return; // api() already showed the login view on 401
  }
  state.user = me.user;
  state.hotels = me.hotels;
  $('#user-name').textContent = me.user.name;
  const sel = $('#hotel-select');
  sel.replaceChildren(...me.hotels.map((ht) => h('option', { value: ht.id }, ht.name)));
  if (!me.hotels.length) {
    $('#login-view').hidden = true;
    $('#app-view').hidden = false;
    $('#cal-grid').replaceChildren(h('div', { class: 'empty' }, 'Your account has no hotels yet. Ask your administrator for access.'));
    return;
  }
  let remembered = null;
  try { remembered = localStorage.getItem('hx_hotel'); } catch { /* storage blocked */ }
  const pick = me.hotels.find((x) => x.id === remembered) ?? me.hotels[0];
  sel.value = pick.id;
  $('#login-view').hidden = true;
  $('#app-view').hidden = false;
  await selectHotel(pick.id);
}

$('#hotel-select').addEventListener('change', (e) => selectHotel(e.target.value));

async function selectHotel(id) {
  state.hotel = state.hotels.find((x) => x.id === id);
  try { localStorage.setItem('hx_hotel', id); } catch { /* ignore */ }
  state.calStart = state.hotel.today;
  const labels = { EXTRANET: 'Managed here', CHANNEL_MANAGER: 'Channel manager', EXTERNAL_B2B: 'B2B supplier' };
  $('#source-badge').textContent = `${labels[state.hotel.source] ?? state.hotel.source} · ${state.hotel.role}`;
  $('#bk-from').value = state.hotel.today;
  $('#bk-to').value = addDays(state.hotel.today, 30);
  for (const b of [$('#new-booking-btn'), $('#new-booking-btn-2')]) b.hidden = !canSell();
  await loadCalendar();
  if (currentTab() === 'bookings') loadBookings();
  if (currentTab() === 'activity') loadActivity();
}

// ---------------------------------------------------------------- tabs
const currentTab = () => document.querySelector('.tab[aria-selected="true"]').dataset.tab;
document.querySelectorAll('.tab').forEach((tab) =>
  tab.addEventListener('click', () => {
    document.querySelectorAll('.tab').forEach((t) => t.setAttribute('aria-selected', String(t === tab)));
    for (const name of ['calendar', 'bookings', 'activity']) $(`#tab-${name}`).hidden = name !== tab.dataset.tab;
    if (tab.dataset.tab === 'bookings') loadBookings();
    if (tab.dataset.tab === 'activity') loadActivity();
  }),
);

// ---------------------------------------------------------------- calendar
$('#cal-prev').addEventListener('click', () => { state.calStart = addDays(state.calStart, -DAYS); loadCalendar(); });
$('#cal-next').addEventListener('click', () => { state.calStart = addDays(state.calStart, DAYS); loadCalendar(); });
$('#cal-today').addEventListener('click', () => { state.calStart = state.hotel.today; loadCalendar(); });

async function loadCalendar() {
  const grid = $('#cal-grid');
  try {
    const data = await api('GET', `/hotels/${state.hotel.id}/calendar?from=${state.calStart}&days=${DAYS}`);
    state.calendar = data;
    renderCalendar(data);
  } catch (err) {
    if (err.status !== 401) grid.replaceChildren(h('div', { class: 'empty' }, explain(err)));
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
    $('#cal-grid').replaceChildren(h('div', { class: 'empty' }, 'No room types set up for this hotel yet.'));
    return;
  }
  const today = state.hotel.today;
  const head = h('tr', {}, h('th', { class: 'room', scope: 'col' }, 'Room type'),
    data.dates.map((d) => h('th', { scope: 'col', class: [d === today ? 'today' : '', dow(d) === 0 || dow(d) === 6 ? 'weekend' : ''].join(' ') },
      fmtDay(d), h('span', { class: 'dnum' }, new Date(d + 'T00:00:00Z').getUTCDate())),
    ));
  const rows = data.roomTypes.map((rt) =>
    h('tr', {},
      h('th', { class: 'room', scope: 'row' }, h('span', { class: 'rname' }, rt.name), h('span', { class: 'rplan' }, rt.ratePlan ? `${rt.ratePlan.name}` : 'No rate plan')),
      rt.days.map((day) => h('td', {}, cellFor(rt, day, today))),
    ),
  );
  $('#cal-grid').replaceChildren(h('table', { class: 'cal' }, h('thead', {}, head), h('tbody', {}, rows)));
}

function cellFor(rt, day, today) {
  let cls = 'free';
  if (!day.loaded) cls = 'unloaded';
  else if (day.stopSell) cls = 'closed';
  else if (day.available === 0) cls = 'out';
  else if (day.available === 1) cls = 'low';
  const sold = day.soldOffline + day.soldOnline;
  const tags = [sold ? `${sold} sold` : '', day.held ? `${day.held} in checkout` : '', day.minLos > 1 ? `min ${day.minLos}n` : '']
    .filter(Boolean).join(' · ');
  const label = `${rt.name}, ${fmtLong(day.date)}: ${day.loaded ? `${day.available} left` : 'no rooms set'}${day.stopSell ? ', closed' : ''}${day.priceMinor ? `, ${inr(day.priceMinor)}` : ''}`;
  return h('button', { type: 'button', class: `cell ${cls}${day.date < today ? ' past' : ''}`, 'aria-label': label, onclick: () => openEditor(rt, day) },
    h('span', { class: 'avail' }, day.loaded ? day.available : '-'),
    h('span', { class: 'price' }, day.priceMinor ? inrShort(day.priceMinor) : ''),
    tags ? h('span', { class: 'tags' }, tags) : null,
  );
}

// ---------------------------------------------------------------- day/range editor
const editForm = $('#edit-form');
const dirty = new Set();
editForm.addEventListener('input', (e) => e.target.name && dirty.add(e.target.name));
editForm.addEventListener('change', (e) => e.target.name && dirty.add(e.target.name));

function openEditor(rt, day) {
  state.editing = { rt, day };
  dirty.clear();
  $('#edit-title').textContent = rt.name;
  $('#edit-sub').textContent = `${fmtLong(day.date)}${rt.ratePlan ? ` · ${rt.ratePlan.name}` : ''}`;
  $('#edit-stats').replaceChildren(
    stat(day.loaded ? day.available : '-', 'left to sell'),
    stat(day.soldOffline, 'sold offline'),
    stat(day.soldOnline, 'sold online'),
    stat(day.held, 'in checkout now'),
  );
  editForm.startDate.value = day.date;
  editForm.endDate.value = day.date;
  editForm.availability.value = day.loaded ? day.available : '';
  editForm.price.value = day.priceMinor ? (day.priceMinor / 100).toFixed(day.priceMinor % 100 ? 2 : 0) : '';
  editForm.minLos.value = day.minLos ?? 1;
  editForm.stopSell.checked = day.stopSell;
  editForm.closedToArrival.checked = day.closedToArrival;
  editForm.closedToDeparture.checked = day.closedToDeparture;
  const editable = canEdit();
  for (const el of editForm.querySelectorAll('input')) el.disabled = !editable;
  $('#edit-save').hidden = !editable;
  $('#edit-readonly').hidden = editable || state.hotel.source !== 'EXTRANET';
  $('#edit-sell').hidden = !canSell();
  $('#edit-error').hidden = true;
  $('#edit-dialog').showModal();
}

const stat = (value, label) => h('div', { class: 'stat' }, h('b', {}, value), h('span', {}, label));

$('#edit-sell').addEventListener('click', () => {
  const { rt, day } = state.editing;
  $('#edit-dialog').close();
  openBooking({ roomTypeId: rt.id, checkIn: day.date });
});

$('#edit-save').addEventListener('click', async () => {
  const f = editForm;
  const err = $('#edit-error');
  err.hidden = true;
  const { rt } = state.editing;
  const startDate = f.startDate.value;
  const endDate = f.endDate.value;
  if (!startDate || !endDate || endDate < startDate) return showErr(err, 'Choose a valid date range.');
  if (!dirty.size || [...dirty].every((n) => n === 'startDate' || n === 'endDate')) return showErr(err, 'Nothing changed yet.');

  // Room-level: rooms left + closing. Rate-level: price, min stay, arrival/departure.
  const roomUpdate = { roomTypeId: rt.id, startDate, endDate };
  const rateUpdate = { roomTypeId: rt.id, ratePlanId: rt.ratePlan?.id, startDate, endDate };
  if (dirty.has('availability')) {
    const n = Number(f.availability.value);
    if (f.availability.value === '' || !Number.isInteger(n) || n < 0) return showErr(err, 'Rooms left must be 0 or more.');
    roomUpdate.availability = n;
  }
  if (dirty.has('stopSell')) roomUpdate.stopSell = f.stopSell.checked;
  if (dirty.has('price')) {
    const p = toPaise(f.price.value);
    if (!(p > 0)) return showErr(err, 'Enter a price like 8500 or 8500.50.');
    rateUpdate.priceMinor = p;
  }
  if (dirty.has('minLos')) {
    const m = Number(f.minLos.value);
    if (!Number.isInteger(m) || m < 1) return showErr(err, 'Minimum stay must be 1 or more nights.');
    rateUpdate.minLos = m;
  }
  if (dirty.has('closedToArrival')) rateUpdate.closedToArrival = f.closedToArrival.checked;
  if (dirty.has('closedToDeparture')) rateUpdate.closedToDeparture = f.closedToDeparture.checked;

  const updates = [];
  if (Object.keys(roomUpdate).length > 3) updates.push(roomUpdate);
  if (Object.keys(rateUpdate).length > 4) {
    if (!rt.ratePlan) return showErr(err, 'This room has no rate plan yet, so prices cannot be set.');
    updates.push(rateUpdate);
  }
  const btn = $('#edit-save');
  btn.disabled = true;
  try {
    await api('PUT', `/hotels/${state.hotel.id}/ari`, { updates });
    $('#edit-dialog').close();
    const days = nightsBetween(startDate, endDate) + 1;
    toast(`Saved for ${days} day${days > 1 ? 's' : ''}. All channels are being updated.`);
    await loadCalendar();
  } catch (ex) {
    if (ex.status !== 401) showErr(err, explain(ex));
  } finally {
    btn.disabled = false;
  }
});

function showErr(el, msg) {
  el.textContent = msg;
  el.hidden = false;
}

// ---------------------------------------------------------------- offline booking
const bkForm = $('#booking-form');
let bkSource = 'WALK_IN';
$('#source-chips').replaceChildren(
  ...SOURCES.map(([code, label]) =>
    h('button', { type: 'button', class: 'chip', 'aria-pressed': String(code === bkSource), dataset: { code }, onclick: () => setSource(code) }, label)),
);
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

/** Shows the calendar price total when every night is in the loaded window. */
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
  const amount = toPaise(f.amount.value);
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

// ---------------------------------------------------------------- bookings list
$('#bk-refresh').addEventListener('click', loadBookings);

async function loadBookings() {
  const list = $('#bk-list');
  const from = $('#bk-from').value;
  const to = $('#bk-to').value;
  try {
    const { reservations } = await api('GET', `/hotels/${state.hotel.id}/reservations?from=${from}&to=${to}`);
    if (!reservations.length) {
      list.replaceChildren(h('div', { class: 'empty' }, 'No bookings in these dates.'));
      return;
    }
    list.replaceChildren(...reservations.map(bookingCard));
  } catch (err) {
    if (err.status !== 401) list.replaceChildren(h('div', { class: 'empty' }, explain(err)));
  }
}

function bookingCard(r) {
  const nights = nightsBetween(r.check_in, r.check_out);
  const offline = r.channel === 'OFFLINE';
  const sourceLabel = offline ? (SOURCES.find(([c]) => c === r.source)?.[1] ?? r.source) : 'Website';
  const actions = offline && canSell() ? (NEXT_ACTIONS[r.status] ?? []) : [];
  return h('article', { class: 'bk' },
    h('div', { class: 'bk-top' },
      h('span', { class: 'bk-name' }, r.guest_name || 'Guest'),
      h('span', { class: `pill ${offline ? r.status : 'ONLINE'}` }, offline ? STATUS_LABEL[r.status] : 'Paid online'),
    ),
    h('div', { class: 'bk-meta' },
      h('span', {}, `${fmtDate(r.check_in)} to ${fmtDate(r.check_out)} (${nights} night${nights > 1 ? 's' : ''})`),
      h('span', {}, `${r.rooms} x ${r.room_name}`),
      h('span', {}, `${sourceLabel}${r.source_detail ? `: ${r.source_detail}` : ''}`),
      r.amount_minor !== null ? h('span', {}, inr(Number(r.amount_minor), r.currency)) : null,
      h('span', { class: 'muted' }, r.reference),
    ),
    r.guest_phone ? h('div', { class: 'bk-meta' }, h('a', { href: `tel:${r.guest_phone.replace(/[^+0-9]/g, '')}` }, r.guest_phone)) : null,
    r.notes ? h('div', { class: 'bk-meta' }, r.notes) : null,
    actions.length
      ? h('div', { class: 'bk-actions' }, actions.map(([to, label, cls]) =>
          h('button', { type: 'button', class: `btn btn-sm ${cls}`, onclick: (e) => changeStatus(r, to, label, e.currentTarget) }, label)))
      : null,
  );
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

// ---------------------------------------------------------------- activity
async function loadActivity() {
  const list = $('#activity-list');
  if (RANK[state.hotel.role] < RANK.manager) {
    list.replaceChildren(h('li', {}, 'The activity log is visible to managers and owners.'));
    return;
  }
  try {
    const { activity } = await api('GET', `/hotels/${state.hotel.id}/activity?limit=100`);
    if (!activity.length) return list.replaceChildren(h('li', {}, 'No changes yet.'));
    list.replaceChildren(...activity.map((a) =>
      h('li', { class: a.action },
        h('div', {}, a.summary),
        h('div', { class: 'when' }, `${a.user_name ?? 'System'} · ${new Date(a.created_at).toLocaleString('en-IN', { dateStyle: 'medium', timeStyle: 'short' })}`),
      )));
  } catch (err) {
    if (err.status !== 401) list.replaceChildren(h('li', {}, explain(err)));
  }
}

boot();
