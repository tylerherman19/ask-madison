const state = {
  asks: [],
  meta: {},
  feedLimit: 10,
  map: null,
  mapLayer: null,
  mapFilter: 'all',
  archiveLoaded: false,
  archiveLoading: null,
};

const content = document.querySelector('#content');
const nav = document.querySelector('#site-nav');
const menuButton = document.querySelector('.menu-button');

const escapeHtml = (value = '') => String(value).replace(/[&<>'"]/g, (char) => ({
  '&': '&amp;', '<': '&lt;', '>': '&gt;', "'": '&#39;', '"': '&quot;'
}[char]));

const fmtDate = (value, options = {}) => {
  if (!value) return 'Not scheduled';
  const date = new Date(value.length === 10 ? `${value}T12:00:00-05:00` : value);
  if (Number.isNaN(date.getTime())) return value;
  return new Intl.DateTimeFormat('en-US', {
    timeZone: 'America/Chicago',
    month: options.short ? 'short' : 'long',
    day: 'numeric',
    year: options.year ? 'numeric' : undefined,
  }).format(date);
};

const fmtHeroDate = () => new Intl.DateTimeFormat('en-US', {
  timeZone: 'America/Chicago', weekday: 'long', month: 'long', day: 'numeric'
}).format(new Date());

const normalizedStatus = (ask) => {
  const s = (ask.status || '').toLowerCase();
  if (/denied|placed on file|withdrawn/.test(s)) return 'Not moving forward';
  if (/approved|recorded|final approval/.test(s)) return 'Approved';
  if (/refer/.test(s)) return 'Referred';
  if (/additional|fee/.test(s)) return 'Waiting on applicant';
  return 'Under review';
};

const eventLabel = (ask) => {
  if (normalizedStatus(ask) === 'Approved') return 'Decided';
  if (ask.change_type === 'changed') return 'Changed';
  return ask.is_current ? 'Asking' : 'Archive';
};

const categoryLabel = { build: 'Build', change: 'Change', fix: 'Fix', use: 'Use', decision: 'Decision' };
const askHref = (ask) => `#ask/${encodeURIComponent(ask.id)}`;
const sourceLink = (ask) => ask.source_url || 'https://www.cityofmadison.com/dpced/planning/development/current-development-proposals/';
const isLiveAsk = (ask) => {
  if (!ask.is_current) return false;
  const currentYear = Number(new Intl.DateTimeFormat('en-US', { timeZone: 'America/Chicago', year: 'numeric' }).format(new Date()));
  const submittedYear = Number(String(ask.submitted_at || '').slice(0, 4));
  const changedYear = Number(String(ask.last_source_update || '').slice(0, 4));
  return submittedYear >= currentYear - 1 || changedYear >= currentYear - 1;
};

function setActiveNav(route) {
  document.querySelectorAll('nav a').forEach((link) => {
    const active = link.dataset.route === route;
    link.toggleAttribute('aria-current', active);
  });
}

function closeMenu() {
  nav.classList.remove('open');
  menuButton.setAttribute('aria-expanded', 'false');
}

menuButton.addEventListener('click', () => {
  const open = !nav.classList.contains('open');
  nav.classList.toggle('open', open);
  menuButton.setAttribute('aria-expanded', String(open));
});
nav.addEventListener('click', closeMenu);

function askItem(ask) {
  const next = ask.next_event_at ? `${fmtDate(ask.next_event_at, { short: true })} · ${ask.next_event_name}` : 'No meeting scheduled';
  const displayCategory = normalizedStatus(ask) === 'Approved' ? 'decision' : ask.category;
  return `
    <article class="ask-item" data-category="${escapeHtml(displayCategory)}">
      <div class="item-top">
        <span class="time">${escapeHtml(eventLabel(ask))}</span>
        <span class="tag">${escapeHtml(categoryLabel[displayCategory] || 'Change')}</span>
      </div>
      <h2><a href="${askHref(ask)}">${escapeHtml(ask.plain_language_headline)}</a></h2>
      <p class="address">${escapeHtml(ask.address)}</p>
      <p class="summary">${escapeHtml(ask.plain_language_summary)}</p>
      <div class="item-meta">
        <div class="meta-unit"><b>Asking for</b><span>${escapeHtml(ask.application_type || 'City review')}</span></div>
        <div class="meta-unit"><b>Status</b><span>${escapeHtml(normalizedStatus(ask))}</span></div>
        <div class="meta-unit"><b>Next</b><span>${escapeHtml(next)}</span></div>
      </div>
      <a class="paper-link" href="${askHref(ask)}">View the paper trail →</a>
    </article>`;
}

function selectHighlights(active) {
  const candidates = [...active].sort((a, b) => {
    const changed = Number(Boolean(b.change_type)) - Number(Boolean(a.change_type));
    if (changed) return changed;
    const size = (b.scale_score || 0) - (a.scale_score || 0);
    if (size) return size;
    return new Date(b.last_source_update || b.updated_at) - new Date(a.last_source_update || a.updated_at);
  });
  const seen = new Set();
  return candidates.filter((ask) => {
    if (seen.has(ask.category)) return false;
    seen.add(ask.category);
    return true;
  }).slice(0, 3).concat(candidates.filter((a) => !seen.has(a.id))).slice(0, 3);
}

function renderToday() {
  setActiveNav('today');
  const active = state.asks.filter(isLiveAsk).sort((a, b) => {
    const bDate = new Date(b.last_source_update || b.submitted_at);
    const aDate = new Date(a.last_source_update || a.submitted_at);
    return bDate - aDate;
  });
  const highlights = selectHighlights(active);
  const decidedThisWeek = active.filter((a) => normalizedStatus(a) === 'Approved').length;
  const upcoming = active.filter((a) => a.next_event_at && new Date(a.next_event_at) >= new Date()).length;
  const visible = active.slice(0, state.feedLimit);

  content.innerHTML = `
    <div class="page-shell">
      <section aria-labelledby="today-title">
        <p class="eyebrow">${escapeHtml(fmtHeroDate())}</p>
        <h1 class="display" id="today-title">What Madison is being asked to change.</h1>
        <p class="dek">Development proposals, public hearings, and city decisions—translated from the paperwork into ordinary language.</p>
        <div class="hero-rule">
          <span>${active.length} active asks</span>
          <span>${decidedThisWeek} decisions in the current feed</span>
          <span>${upcoming} upcoming hearings</span>
          <span>Updated ${escapeHtml(fmtDate(state.meta.generated_at, { short: true }))}</span>
        </div>
      </section>

      <section class="today-module" aria-labelledby="madison-today">
        <div class="section-kicker">
          <h2 id="madison-today">Madison today</h2>
          <p>Selected by transparent rules: recent change, scale, and upcoming action.</p>
        </div>
        <div class="today-grid">
          ${highlights.map((ask) => `
            <article class="brief">
              <span class="brief-type">${escapeHtml(ask.change_type || (ask.scale_score > 100 ? 'Large proposal' : 'Active ask'))}</span>
              <h3><a href="${askHref(ask)}">${escapeHtml(ask.plain_language_headline)}</a></h3>
              <p>${escapeHtml(ask.address)}${ask.next_event_at ? ` · ${escapeHtml(fmtDate(ask.next_event_at, { short: true }))}` : ''}</p>
            </article>`).join('')}
        </div>
      </section>

      <div class="feed-layout">
        <section aria-labelledby="feed-title">
          <h2 class="feed-heading" id="feed-title">The latest asks</h2>
          <div id="feed">${visible.map(askItem).join('')}</div>
          ${visible.length < active.length ? `<button class="load-more" type="button" id="load-more">Show more asks</button>` : ''}
        </section>
        <aside class="rail" aria-label="About this feed">
          <div class="rail-block">
            <h3>Reading the feed</h3>
            <ul>
              <li><i class="key-dot build"></i> Build or create</li>
              <li><i class="key-dot"></i> Change a property</li>
              <li><i class="key-dot fix"></i> Fix infrastructure</li>
              <li><i class="key-dot use"></i> Use a place differently</li>
              <li><i class="key-dot decision"></i> City decision</li>
            </ul>
          </div>
          <div class="rail-block">
            <h3>What this is</h3>
            <p>Each story starts with a City of Madison record. The original wording and documents stay one click away.</p>
          </div>
          <div class="rail-block">
            <h3>See a mistake?</h3>
            <p>Use the original record to verify details. A public correction channel can be added after launch.</p>
          </div>
        </aside>
      </div>
    </div>`;

  document.querySelector('#load-more')?.addEventListener('click', () => {
    state.feedLimit += 10;
    renderToday();
    document.querySelector('#feed')?.scrollIntoView({ block: 'start' });
  });
}

function markerColor(ask) {
  const category = normalizedStatus(ask) === 'Approved' ? 'decision' : ask.category;
  return ({ build: '#64806b', change: '#bc7448', fix: '#577a8f', use: '#765e7f', decision: '#242827' })[category] || '#bc7448';
}

function renderMapMarkers() {
  if (!state.map || !window.L) return;
  state.mapLayer?.clearLayers();
  const asks = state.asks.filter((ask) => isLiveAsk(ask) && ask.latitude && ask.longitude)
    .filter((ask) => state.mapFilter === 'all' || (state.mapFilter === 'decision' ? normalizedStatus(ask) === 'Approved' : ask.category === state.mapFilter));
  asks.forEach((ask) => {
    const color = markerColor(ask);
    const marker = window.L.circleMarker([ask.latitude, ask.longitude], {
      radius: 8, color: '#fffdf8', weight: 2, fillColor: color, fillOpacity: .94
    });
    marker.bindPopup(`<span class="map-popup-type">${escapeHtml(categoryLabel[normalizedStatus(ask) === 'Approved' ? 'decision' : ask.category] || 'Change')}</span><h3 class="map-popup-title"><a href="${askHref(ask)}">${escapeHtml(ask.plain_language_headline)}</a></h3><span class="map-popup-address">${escapeHtml(ask.address)}</span>`);
    marker.addTo(state.mapLayer);
  });
}

function renderMap() {
  setActiveNav('map');
  content.innerHTML = `
    <div class="page-shell">
      <section class="map-intro">
        <p class="eyebrow">Place matters</p>
        <h1 class="display">What Madison is asking for.</h1>
        <p class="dek">Active and recently decided proposals, placed where the requested change would happen.</p>
      </section>
      <div class="map-wrap">
        <div class="map-filter" role="group" aria-label="Filter map markers">
          ${[['all','All'],['build','Build'],['change','Change'],['fix','Fix'],['use','Use'],['decision','Decision']].map(([value, label]) => `<button type="button" data-map-filter="${value}" class="${state.mapFilter === value ? 'active' : ''}">${label}</button>`).join('')}
        </div>
        <div id="map-canvas" aria-label="Map of current asks in Madison"></div>
      </div>
      <p class="source-note">Locations are matched to Madison’s public parcel data. An item stays in the feed even when a parcel cannot be matched.</p>
    </div>`;

  if (!window.L) {
    document.querySelector('#map-canvas').innerHTML = '<div class="empty"><h2>The map could not load.</h2><p>The stories are still available in Today and Archive.</p></div>';
    return;
  }
  state.map = window.L.map('map-canvas', { scrollWheelZoom: false }).setView([43.0731, -89.4012], 12);
  window.L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
    maxZoom: 19,
    attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a>'
  }).addTo(state.map);
  state.mapLayer = window.L.layerGroup().addTo(state.map);
  renderMapMarkers();
  document.querySelector('.map-filter').addEventListener('click', (event) => {
    const button = event.target.closest('button[data-map-filter]');
    if (!button) return;
    state.mapFilter = button.dataset.mapFilter;
    document.querySelectorAll('[data-map-filter]').forEach((b) => b.classList.toggle('active', b === button));
    renderMapMarkers();
  });
}

function archiveRow(ask) {
  return `<article class="archive-row">
    <time datetime="${escapeHtml(ask.submitted_at)}">${escapeHtml(fmtDate(ask.submitted_at, { short: true, year: true }))}</time>
    <h3><a href="${askHref(ask)}">${escapeHtml(ask.plain_language_headline)}</a></h3>
    <span class="archive-address">${escapeHtml(ask.address)}</span>
    <span class="archive-status">${escapeHtml(normalizedStatus(ask))}</span>
  </article>`;
}

async function ensureArchiveLoaded() {
  if (state.archiveLoaded) return;
  if (!state.archiveLoading) {
    state.archiveLoading = Promise.all((state.meta.archive_files || []).map(async (file) => {
      const response = await fetch(`./data/${file}`, { cache: 'no-cache' });
      if (!response.ok) throw new Error(`Archive request failed: ${response.status}`);
      return response.json();
    })).then((groups) => {
      const byId = new Map(state.asks.map((ask) => [ask.id, ask]));
      groups.flatMap((group) => group.asks || []).forEach((ask) => byId.set(ask.id, ask));
      state.asks = [...byId.values()];
      state.archiveLoaded = true;
    });
  }
  return state.archiveLoading;
}

async function renderArchive() {
  setActiveNav('archive');
  if (!state.archiveLoaded) {
    content.innerHTML = `<div class="page-shell"><section class="archive-intro"><p class="eyebrow">A civic memory</p><h1 class="display">The archive</h1><p class="dek">Loading development proposals from ${escapeHtml(state.meta.archive_start_year || '2015')} forward…</p></section><div class="loading-state" role="status"><span class="loading-line"></span><p>Opening the archive…</p></div></div>`;
    try {
      await ensureArchiveLoaded();
    } catch (error) {
      console.error(error);
      content.innerHTML = '<div class="error-state"><p class="eyebrow">Archive unavailable</p><h1>The historical records could not be loaded.</h1><p><a href="#today">Return to current asks →</a></p></div>';
      return;
    }
    if (location.hash !== '#archive') return;
  }
  const years = [...new Set(state.asks.map((a) => String(a.submitted_at || '').slice(0, 4)).filter(Boolean))].sort().reverse();
  const categories = ['all', ...new Set(state.asks.map((a) => a.category).filter(Boolean))];
  content.innerHTML = `
    <div class="page-shell">
      <section class="archive-intro">
        <p class="eyebrow">A civic memory</p>
        <h1 class="display">The archive</h1>
        <p class="dek">Search development proposals by the words people actually use: an address, a street, apartments, demolition, a patio.</p>
      </section>
      <div class="tools">
        <input id="archive-search" type="search" placeholder="Search an address, project, or type…" aria-label="Search asks" />
        <select id="archive-year" aria-label="Filter by year"><option value="all">All years</option>${years.map((y) => `<option>${escapeHtml(y)}</option>`).join('')}</select>
        <select id="archive-category" aria-label="Filter by category">${categories.map((c) => `<option value="${escapeHtml(c)}">${c === 'all' ? 'All categories' : escapeHtml(categoryLabel[c] || c)}</option>`).join('')}</select>
      </div>
      <p class="result-count" id="archive-count"></p>
      <section class="archive-list" id="archive-results" aria-live="polite"></section>
    </div>`;

  const search = document.querySelector('#archive-search');
  const year = document.querySelector('#archive-year');
  const category = document.querySelector('#archive-category');
  const results = document.querySelector('#archive-results');
  const count = document.querySelector('#archive-count');
  const update = () => {
    const query = search.value.trim().toLowerCase();
    const filtered = state.asks.filter((ask) => {
      const haystack = [ask.address, ask.raw_title, ask.raw_description, ask.plain_language_headline, ask.application_type, ask.neighborhood].join(' ').toLowerCase();
      return (!query || haystack.includes(query)) && (year.value === 'all' || String(ask.submitted_at).startsWith(year.value)) && (category.value === 'all' || ask.category === category.value);
    }).sort((a, b) => new Date(b.submitted_at) - new Date(a.submitted_at)).slice(0, 150);
    count.textContent = `${filtered.length}${filtered.length === 150 ? '+' : ''} matching asks`;
    results.innerHTML = filtered.length ? filtered.map(archiveRow).join('') : '<div class="empty"><h2>No asks match that search.</h2><p>Try a street name, project type, or a broader year.</p></div>';
  };
  search.addEventListener('input', update);
  year.addEventListener('change', update);
  category.addEventListener('change', update);
  update();
}

function detailTimeline(ask) {
  const events = [...(ask.events || [])].sort((a, b) => new Date(a.event_date) - new Date(b.event_date));
  if (!events.length) return '<p class="source-note">No dated actions have been published yet.</p>';
  return `<ol class="timeline">${events.map((event) => `<li>
    <time datetime="${escapeHtml(event.event_date)}">${escapeHtml(fmtDate(event.event_date, { short: true, year: true }))}</time>
    <div><h3>${escapeHtml(event.title)}</h3>${event.description ? `<p>${escapeHtml(event.description)}</p>` : ''}</div>
  </li>`).join('')}</ol>`;
}

function initSideMap(ask) {
  if (!window.L || !ask.latitude || !ask.longitude) return;
  const map = window.L.map('side-map', { zoomControl: false, scrollWheelZoom: false, dragging: false }).setView([ask.latitude, ask.longitude], 15);
  window.L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', { maxZoom: 19, attribution: '&copy; OpenStreetMap' }).addTo(map);
  window.L.circleMarker([ask.latitude, ask.longitude], { radius: 9, color: '#fffdf8', weight: 2, fillColor: markerColor(ask), fillOpacity: 1 }).addTo(map);
}

function renderDetail(id) {
  setActiveNav('');
  const ask = state.asks.find((item) => item.id === decodeURIComponent(id));
  if (!ask) {
    if (!state.archiveLoaded) {
      content.innerHTML = '<div class="loading-state" role="status"><span class="loading-line"></span><p>Finding this ask in the archive…</p></div>';
      ensureArchiveLoaded().then(() => renderDetail(id)).catch(() => {
        content.innerHTML = '<div class="error-state"><p class="eyebrow">Archive unavailable</p><h1>This ask could not be loaded.</h1><p><a href="#archive">Search the archive →</a></p></div>';
      });
      return;
    }
    content.innerHTML = '<div class="error-state"><p class="eyebrow">Record not found</p><h1>This ask is not in the archive.</h1><p><a href="#archive">Search the archive →</a></p></div>';
    return;
  }
  const docs = (ask.attachments || []).filter((a) => a.title).slice(0, 16);
  content.innerHTML = `
    <div class="page-shell">
      <a class="detail-back" href="${ask.is_current ? '#today' : '#archive'}">← Back to ${ask.is_current ? 'today' : 'the archive'}</a>
      <div class="detail-grid">
        <article>
          <p class="eyebrow">${escapeHtml(eventLabel(ask))} · ${escapeHtml(categoryLabel[ask.category] || 'Change')}</p>
          <h1 class="detail-title">${escapeHtml(ask.plain_language_headline)}</h1>
          <p class="detail-address">${escapeHtml(ask.address)}</p>
          <p class="detail-summary">${escapeHtml(ask.plain_language_summary)}</p>

          <section class="detail-section">
            <h2>What they’re asking for</h2>
            <p>${escapeHtml(ask.raw_description)}</p>
            <div class="fact-grid">
              <div class="fact"><b>Application</b><span>${escapeHtml(ask.application_type || 'City review')}</span></div>
              <div class="fact"><b>Status</b><span>${escapeHtml(normalizedStatus(ask))}</span></div>
              <div class="fact"><b>Submitted</b><span>${escapeHtml(fmtDate(ask.submitted_at, { year: true }))}</span></div>
              <div class="fact"><b>Responsible body</b><span>${escapeHtml(ask.responsible_body || 'City of Madison')}</span></div>
            </div>
          </section>

          <section class="detail-section">
            <h2>What happens next</h2>
            <p>${ask.next_event_at ? `${escapeHtml(ask.next_event_name)} is listed for ${escapeHtml(fmtDate(ask.next_event_at, { year: true }))}.` : 'The source record does not list another scheduled meeting or action.'}</p>
          </section>

          <section class="detail-section">
            <h2>The paper trail</h2>
            ${detailTimeline(ask)}
          </section>

          <section class="detail-section">
            <h2>Original documents</h2>
            ${docs.length ? `<ul class="documents">${docs.map((doc) => `<li><a href="${escapeHtml(doc.url || sourceLink(ask))}" target="_blank" rel="noopener"><span>${escapeHtml(doc.title)}</span><span>↗</span></a></li>`).join('')}</ul>` : '<p class="source-note">No separate attachments were listed in the public API.</p>'}
            <p><a class="paper-link" href="${escapeHtml(sourceLink(ask))}" target="_blank" rel="noopener">Open the original City record →</a></p>
          </section>
        </article>
        <aside>
          ${ask.latitude && ask.longitude ? '<div class="side-map" id="side-map" aria-label="Project location"></div>' : ''}
          <div class="rail-block">
            <h3>Source</h3>
            <p class="source-note">City of Madison Planning${ask.legistar_file_number ? ` and Legistar file ${escapeHtml(ask.legistar_file_number)}` : ''}. Retrieved ${escapeHtml(fmtDate(ask.last_checked_at, { short: true, year: true }))}.</p>
            <p><a href="${escapeHtml(sourceLink(ask))}" target="_blank" rel="noopener">View source record ↗</a></p>
          </div>
          ${ask.parcel_id ? `<div class="rail-block"><h3>Parcel match</h3><p>${escapeHtml(ask.parcel_id)}${ask.property_use ? ` · ${escapeHtml(ask.property_use)}` : ''}</p></div>` : ''}
          <div class="rail-block">
            <h3>Plain-language note</h3>
            <p>This summary is generated from the public record. If the source is ambiguous, the City’s wording controls.</p>
          </div>
        </aside>
      </div>
    </div>`;
  initSideMap(ask);
}

function renderAbout() {
  setActiveNav('about');
  content.innerHTML = `
    <div class="page-shell">
      <section class="about-intro">
        <p class="eyebrow">About this project</p>
        <h1 class="display">The action behind the paperwork.</h1>
        <p class="dek">Ask Madison watches public City of Madison records and translates them into plain English. It is an independent project and is not affiliated with the City of Madison.</p>
      </section>
      <div class="about-grid">
        <article class="prose">
          <h2>Why it exists</h2>
          <p>Government websites usually organize information around agencies, committees, file numbers, and permit language. Ask Madison begins somewhere else: with the physical or human change being requested.</p>
          <p>“Conditional use for outdoor amplified sound” becomes “Someone wants amplified music outside this brewery.” The original terminology, file number, and documents remain available beneath the summary.</p>
          <h2>What it watches</h2>
          <p>The first version reads Current and Past Development Proposals from Madison Planning, enriches projects with public Legistar histories and attachments, and matches addresses to the City’s parcel layer when possible.</p>
          <h2>What it does not do</h2>
          <p>It does not decide whether a proposal is good or bad. It does not rank public opinion, identify private residents, or fill gaps with invented facts. If the automated summary is uncertain, it stays close to the City’s wording.</p>
          <h2>Corrections</h2>
          <p>The public source linked on every page is authoritative. A correction channel can be added after launch; until then, verify disputed details against that record.</p>
        </article>
        <aside class="method-box">
          <h2>How the feed works</h2>
          <dl>
            <div><dt>Sources</dt><dd>Madison Planning, Legistar, and City parcel data</dd></div>
            <div><dt>Update schedule</dt><dd>Every four hours</dd></div>
            <div><dt>Historical coverage</dt><dd>${escapeHtml(state.meta.archive_start_year || '2015')} to present</dd></div>
            <div><dt>Records in this snapshot</dt><dd>${Number(state.meta.record_count || state.asks.length).toLocaleString()}</dd></div>
            <div><dt>Last generated</dt><dd>${escapeHtml(fmtDate(state.meta.generated_at, { year: true }))}</dd></div>
            <div><dt>Transformation</dt><dd>Rule-based plain-English summaries with original text preserved</dd></div>
          </dl>
        </aside>
      </div>
    </div>`;
}

function route() {
  if (state.map) {
    state.map.remove();
    state.map = null;
    state.mapLayer = null;
  }
  const hash = location.hash.replace(/^#/, '') || 'today';
  const [routeName, ...rest] = hash.split('/');
  if (routeName === 'ask') renderDetail(rest.join('/'));
  else if (routeName === 'map') renderMap();
  else if (routeName === 'archive') renderArchive();
  else if (routeName === 'about') renderAbout();
  else renderToday();
  window.scrollTo({ top: 0, behavior: 'instant' });
}

async function init() {
  try {
    const response = await fetch('./data/asks.json', { cache: 'no-cache' });
    if (!response.ok) throw new Error(`Data request failed: ${response.status}`);
    const data = await response.json();
    state.asks = data.asks || [];
    state.meta = data.meta || {};
    if (!state.asks.length) throw new Error('No asks were found.');
    route();
  } catch (error) {
    console.error(error);
    content.innerHTML = `<div class="error-state"><p class="eyebrow">The feed is unavailable</p><h1>Madison’s asks could not be loaded.</h1><p>The public source may be temporarily unavailable. Try again, or read the <a href="https://www.cityofmadison.com/dpced/planning/development/current-development-proposals/">City’s current development proposals</a>.</p></div>`;
  }
}

window.addEventListener('hashchange', route);
init();
