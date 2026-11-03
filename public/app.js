(() => {
'use strict';
const $app = document.getElementById('app');
const S = { token: localStorage.getItem('token'), me: null, feedScope: 'all', pollTimer: null };

// ---------- utils ----------
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const linkify = t => esc(t)
  .replace(/(^|[\s(])#([\p{L}\p{N}_]{1,40})/gu, '$1<a href="#/tag/$2">#$2</a>')
  .replace(/(^|[\s(])@([A-Za-z0-9_]{3,20})/g, '$1<a href="#/u/$2">@$2</a>');
const ago = ts => {
  const s = Math.max(1, (Date.now() - ts) / 1000);
  if (s < 60) return 'now';
  if (s < 3600) return Math.floor(s / 60) + 'm';
  if (s < 86400) return Math.floor(s / 3600) + 'h';
  if (s < 604800) return Math.floor(s / 86400) + 'd';
  return new Date(ts).toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
};
const hue = str => [...str].reduce((a, c) => (a * 31 + c.charCodeAt(0)) % 360, 7);
const av = (u, cls = '') => u.avatar
  ? `<img class="av ${cls}" src="${esc(u.avatar)}" alt="" loading="lazy">`
  : `<div class="av ${cls}" style="background:hsl(${hue(u.username)} 62% 52%)" aria-hidden="true">${esc((u.display_name || u.username)[0])}</div>`;
let toastT;
const toast = m => { const t = document.getElementById('toast'); t.textContent = m; t.classList.add('show'); clearTimeout(toastT); toastT = setTimeout(() => t.classList.remove('show'), 2600); };
const $ = (s, r = document) => r.querySelector(s);

async function api(path, { method = 'GET', body, form } = {}) {
  const headers = {};
  if (S.token) headers.Authorization = 'Bearer ' + S.token;
  let payload;
  if (form) payload = form; else if (body) { headers['Content-Type'] = 'application/json'; payload = JSON.stringify(body); }
  const res = await fetch('/api' + path, { method, headers, body: payload });
  const data = await res.json().catch(() => ({}));
  if (res.status === 401 && S.token) { logout(); throw new Error('Session expired'); }
  if (!res.ok) throw new Error(data.error || 'Something went wrong');
  return data;
}
const need = () => { if (!S.me) { location.hash = '#/login'; return false; } return true; };
function logout() { S.token = null; S.me = null; localStorage.removeItem('token'); clearInterval(S.pollTimer); location.hash = '#/login'; }

const I = {
  home: '<path d="M3 11l9-8 9 8v9a1 1 0 0 1-1 1h-5v-6H9v6H4a1 1 0 0 1-1-1z"/>',
  explore: '<path d="M13.5 2c.5 4-3 5.5-3 9 0 1.5 1 2.5 2 2.5 0-1.5 1.5-2 1.5-3.5 2.5 2 4 4 4 6.5a6 6 0 0 1-12 0C6 11 9 9 9 6c1.5.5 3-.5 4.5-4z"/>',
  bell: '<path d="M6 8a6 6 0 0 1 12 0c0 7 3 9 3 9H3s3-2 3-9M10.3 21a1.9 1.9 0 0 0 3.4 0"/>',
  user: '<circle cx="12" cy="8" r="4"/><path d="M4 21c0-4 4-6 8-6s8 2 8 6"/>',
  heart: '<path d="M20.8 4.6a5.5 5.5 0 0 0-7.8 0L12 5.7l-1-1.1a5.5 5.5 0 0 0-7.8 7.8l1 1.1L12 21l7.8-7.5 1-1.1a5.5 5.5 0 0 0 0-7.8z"/>',
  chat: '<path d="M21 12a8 8 0 0 1-11.7 7L3 21l2-5.3A8 8 0 1 1 21 12z"/>',
  img: '<rect x="3" y="3" width="18" height="18" rx="3"/><circle cx="8.5" cy="8.5" r="1.5"/><path d="M21 15l-5-5L5 21"/>',
  trash: '<path d="M3 6h18M8 6V4h8v2M6 6l1 15h10l1-15"/>',
  out: '<path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4M16 17l5-5-5-5M21 12H9"/>',
};
const svg = k => `<svg viewBox="0 0 24 24" aria-hidden="true">${I[k]}</svg>`;

// ---------- components ----------
function postHTML(p, open = false) {
  const mine = S.me && S.me.id === p.author.id;
  const media = p.media ? `<div class="media">${p.media.type === 'video'
    ? `<video src="${esc(p.media.url)}" controls preload="metadata" playsinline></video>`
    : `<img src="${esc(p.media.url)}" alt="Image posted by ${esc(p.author.username)}" loading="lazy">`}</div>` : '';
  return `<article class="card post" data-post="${p.id}">
    <a href="#/u/${esc(p.author.username)}">${av(p.author)}</a>
    <div class="body">
      <div class="head"><a class="name" href="#/u/${esc(p.author.username)}">${esc(p.author.display_name)}</a>
        <span class="muted">@${esc(p.author.username)} · <a href="#/p/${p.id}">${ago(p.created_at)}</a></span></div>
      ${p.text ? `<div class="text">${linkify(p.text)}</div>` : ''}
      ${media}
      ${p.tags.length ? `<div class="tags">${p.tags.map(t => `<a class="pill" href="#/tag/${esc(t)}">#${esc(t)}</a>`).join('')}</div>` : ''}
      <div class="actions">
        <button class="act ${p.liked ? 'liked' : ''}" data-act="like" aria-pressed="${p.liked}" aria-label="Like">${svg('heart')}<span>${p.like_count || ''}</span></button>
        <button class="act" data-act="comments" aria-label="Comments">${svg('chat')}<span>${p.comment_count || ''}</span></button>
        ${mine ? `<button class="act del" data-act="delete" aria-label="Delete post">${svg('trash')}</button>` : ''}
      </div>
      <div class="comments ${open ? '' : 'hidden'}"></div>
    </div></article>`;
}
const userRow = u => `<div class="user-row"><a href="#/u/${esc(u.username)}">${av(u, 'sm')}</a>
  <a class="who" href="#/u/${esc(u.username)}"><b>${esc(u.display_name)}</b><span class="muted">@${esc(u.username)}</span></a>
  ${S.me && S.me.id !== u.id ? `<button class="btn sm ${u.is_following ? 'ghost' : ''}" data-follow="${esc(u.username)}">${u.is_following ? 'Following' : 'Follow'}</button>` : ''}</div>`;
const empty = (t, s) => `<div class="card empty"><b>${t}</b>${s}</div>`;
const spinner = '<div class="spinner" role="progressbar" aria-label="Loading"></div>';

// ---------- layout ----------
function shell(active) {
  const nav = [['home', '#/', 'Home', 'home'], ['explore', '#/explore', 'Explore', 'explore'], ['notifications', '#/notifications', 'Notifications', 'bell']];
  if (S.me) nav.push(['profile', '#/u/' + S.me.username, 'Profile', 'user']);
  $app.innerHTML = `<div class="shell">
    <nav class="nav" aria-label="Main">
      <a class="logo" href="#/"><i><svg viewBox="0 0 32 32"><path d="M16 4l3 9 9 3-9 3-3 9-3-9-9-3 9-3z"/></svg></i><b>Sparkle</b></a>
      ${nav.map(([k, h, l, ic]) => `<a class="item ${active === k ? 'active' : ''}" href="${h}" aria-label="${l}">${svg(ic)}<span class="l">${l}</span>${k === 'notifications' ? '<em class="badge hidden" id="nbadge"></em>' : ''}</a>`).join('')}
      <div class="spacer"></div>
      ${S.me ? `<a class="item" href="#" data-logout aria-label="Log out">${svg('out')}<span class="l">Log out</span></a>
        <a class="me-chip" href="#/u/${esc(S.me.username)}">${av(S.me, 'sm')}<span class="who"><b>${esc(S.me.display_name)}</b><br><span class="muted">@${esc(S.me.username)}</span></span></a>`
        : `<a class="btn" href="#/login" style="text-align:center">Log in</a>`}
    </nav>
    <main id="main"></main>
    <aside class="side" id="side"></aside></div>`;
  updateBadge(S.me ? S.me.unread : 0);
  loadSide();
  return $('#main');
}
function updateBadge(n) {
  const b = $('#nbadge'); if (!b) return;
  b.textContent = n > 99 ? '99+' : n; b.classList.toggle('hidden', !n);
}
async function loadSide() {
  const side = $('#side'); if (!side) return;
  side.innerHTML = `<div class="search"><input type="search" id="q" placeholder="Search people" aria-label="Search people" autocomplete="off"><div class="results card hidden" id="results"></div></div>
    <section class="card" id="trendbox"><h3>Trending</h3>${spinner}</section>
    ${S.me ? '<section class="card hidden" id="sugbox"><h3>Who to follow</h3></section>' : ''}`;
  try {
    const t = await api('/trending');
    const box = $('#trendbox'); if (!box) return;
    box.innerHTML = '<h3>Trending this week</h3>' + (t.tags.length
      ? t.tags.slice(0, 6).map(x => `<a class="trend" href="#/tag/${esc(x.tag)}"><b>#${esc(x.tag)}</b><span>${x.posts} post${x.posts > 1 ? 's' : ''}</span></a>`).join('') + '<div style="height:8px"></div>'
      : '<p class="muted" style="padding:0 18px 16px;margin:0">Nothing yet — try #hello in a post!</p>');
  } catch {}
  if (S.me) try {
    const sug = await api('/users/suggestions'); const box = $('#sugbox');
    if (box && sug.length) { box.classList.remove('hidden'); box.insertAdjacentHTML('beforeend', sug.map(userRow).join('') + '<div style="height:6px"></div>'); }
  } catch {}
}

// ---------- views ----------
async function authView(mode) {
  $app.innerHTML = `<div class="auth"><form class="card box" novalidate>
    <h1>✦ Sparkle</h1><p>${mode === 'login' ? 'Welcome back. Share what lights you up.' : 'Create your profile and start sharing.'}</p>
    ${mode === 'register' ? '<label class="field"><span>Display name</span><input name="display_name" maxlength="50" autocomplete="name"></label>' : ''}
    <label class="field"><span>Username</span><input name="username" required minlength="3" maxlength="20" autocomplete="username" autocapitalize="off"></label>
    <label class="field"><span>Password</span><input name="password" type="password" required minlength="8" autocomplete="${mode === 'login' ? 'current-password' : 'new-password'}"></label>
    <p class="err" role="alert"></p>
    <button class="btn" style="width:100%;padding:12px">${mode === 'login' ? 'Log in' : 'Sign up'}</button>
    <div class="switch">${mode === 'login' ? `New here? <a href="#/register">Create an account</a>` : `Have an account? <a href="#/login">Log in</a>`}<br><a href="#/" style="font-weight:500;color:var(--muted)">Just browse</a></div></form></div>`;
  $('form').addEventListener('submit', async e => {
    e.preventDefault();
    const f = Object.fromEntries(new FormData(e.target)), btn = $('button', e.target);
    btn.disabled = true;
    try {
      const r = await api('/auth/' + mode, { method: 'POST', body: f });
      S.token = r.token; localStorage.setItem('token', r.token);
      await loadMe(); location.hash = '#/';
    } catch (err) { $('.err').textContent = err.message; btn.disabled = false; }
  });
}

function composerHTML() {
  return `<form class="card composer" id="composer">${av(S.me)}<div class="body">
    <textarea name="text" maxlength="500" placeholder="What's sparkling today?  Use #tags and @mentions" aria-label="New post"></textarea>
    <div class="preview hidden" id="preview"></div>
    <div class="tagrow"><span class="muted">#</span><input type="text" name="tags" placeholder="Add tags: travel food art" aria-label="Tags" maxlength="120"></div>
    <div class="tools">
      <label class="icon-btn" title="Add photo or video" tabindex="0" role="button" aria-label="Add photo or video">${svg('img')}
        <input type="file" name="media" accept="image/jpeg,image/png,image/gif,image/webp,video/mp4,video/webm,video/quicktime" hidden></label>
      <span class="count" id="count">0/500</span>
      <button class="btn" disabled>Post</button></div></div></form>`;
}
function bindComposer(onPosted) {
  const f = $('#composer'); if (!f) return;
  const ta = f.text, file = f.media, btn = $('.btn', f);
  let url;
  const refresh = () => {
    $('#count').textContent = ta.value.length + '/500';
    $('#count').classList.toggle('warn', ta.value.length > 450);
    btn.disabled = !ta.value.trim() && !file.files[0];
    ta.style.height = 'auto'; ta.style.height = Math.max(56, ta.scrollHeight) + 'px';
  };
  const clearMedia = () => { file.value = ''; if (url) URL.revokeObjectURL(url); $('#preview').classList.add('hidden'); $('#preview').innerHTML = ''; refresh(); };
  ta.addEventListener('input', refresh);
  $('.icon-btn', f).addEventListener('keydown', e => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); file.click(); } });
  file.addEventListener('change', () => {
    const x = file.files[0]; if (!x) return;
    if (x.size > 50 * 1024 * 1024) { toast('File too large (max 50 MB)'); return clearMedia(); }
    if (url) URL.revokeObjectURL(url);
    url = URL.createObjectURL(x);
    const p = $('#preview'); p.classList.remove('hidden');
    p.innerHTML = (x.type.startsWith('video') ? `<video src="${url}" controls muted playsinline></video>` : `<img src="${url}" alt="Preview">`) + '<button type="button" class="x" aria-label="Remove media">×</button>';
    $('.x', p).onclick = clearMedia; refresh();
  });
  f.addEventListener('submit', async e => {
    e.preventDefault(); btn.disabled = true; btn.textContent = 'Posting…';
    try {
      const post = await api('/posts', { method: 'POST', form: new FormData(f) });
      f.reset(); clearMedia(); toast('Posted ✦'); onPosted(post);
    } catch (err) { toast(err.message); }
    btn.textContent = 'Post'; refresh();
  });
}

// feed list with "load more"
function feedList(container, fetcher, emptyMsg) {
  let last = null;
  const holder = document.createElement('div'); container.appendChild(holder);
  const more = document.createElement('button'); more.className = 'btn ghost more hidden'; more.textContent = 'Load more'; container.appendChild(more);
  async function load() {
    holder.insertAdjacentHTML('beforeend', spinner);
    try {
      const posts = await fetcher(last);
      holder.querySelector('.spinner')?.remove();
      if (!last && !posts.length) holder.innerHTML = emptyMsg;
      holder.insertAdjacentHTML('beforeend', posts.map(p => postHTML(p)).join(''));
      if (posts.length) last = posts[posts.length - 1].id;
      more.classList.toggle('hidden', posts.length < 20 || fetcher.length === 0);
    } catch (e) { holder.querySelector('.spinner')?.remove(); holder.insertAdjacentHTML('beforeend', empty('Couldn’t load', esc(e.message))); }
  }
  more.onclick = load; load();
  return { prepend: p => { holder.querySelector('.empty')?.remove(); holder.insertAdjacentHTML('afterbegin', postHTML(p)); } };
}

async function homeView() {
  const main = shell('home');
  main.innerHTML = `<h1 class="page-title">Home</h1>` + (S.me ? composerHTML() +
    `<div class="tabs" role="tablist"><button role="tab" data-scope="all" class="${S.feedScope === 'all' ? 'on' : ''}">For you</button><button role="tab" data-scope="following" class="${S.feedScope === 'following' ? 'on' : ''}">Following</button></div>`
    : `<div class="card empty"><b>Join the conversation</b><a class="btn" href="#/register">Sign up</a></div><div style="height:14px"></div>`) + '<div id="feed"></div>';
  let list;
  const mount = () => {
    $('#feed').innerHTML = '';
    list = feedList($('#feed'), last => api(`/feed?scope=${S.feedScope}${last ? '&before=' + last : ''}`),
      S.feedScope === 'following' ? empty('Your feed is quiet', 'Follow people to see their posts here.') : empty('No posts yet', 'Be the first to share something!'));
  };
  mount();
  bindComposer(p => list.prepend(p));
  main.querySelectorAll('.tabs button').forEach(b => b.onclick = () => {
    S.feedScope = b.dataset.scope; main.querySelectorAll('.tabs button').forEach(x => x.classList.toggle('on', x === b)); mount();
  });
}

async function exploreView() {
  const main = shell('explore');
  main.innerHTML = '<h1 class="page-title">Explore</h1>' + spinner;
  try {
    const t = await api('/trending');
    main.innerHTML = `<h1 class="page-title">Explore</h1>
      ${t.tags.length ? `<div class="tags" style="margin-bottom:16px">${t.tags.map(x => `<a class="pill" href="#/tag/${esc(x.tag)}">#${esc(x.tag)} · ${x.posts}</a>`).join('')}</div>` : ''}
      <h2 style="font:700 18px var(--display);margin:0 0 10px">🔥 Trending posts</h2>
      ${t.posts.length ? t.posts.map(p => postHTML(p)).join('') : empty('Nothing trending yet', 'Posts that get likes and comments will show up here.')}`;
  } catch (e) { main.innerHTML = empty('Couldn’t load', esc(e.message)); }
}

async function tagView(tag) {
  const main = shell('explore');
  main.innerHTML = `<h1 class="page-title"><a class="icon-btn" href="#/explore" aria-label="Back">←</a> #${esc(tag)}</h1><div id="feed"></div>`;
  feedList($('#feed'), last => api(`/feed?tag=${encodeURIComponent(tag)}${last ? '&before=' + last : ''}`), empty('No posts with this tag', 'Be the first!'));
}

async function profileView(username) {
  const main = shell('profile'); main.innerHTML = spinner;
  try {
    const [u, posts] = await Promise.all([api('/users/' + encodeURIComponent(username)), api(`/users/${encodeURIComponent(username)}/posts`)]);
    const mine = S.me && S.me.id === u.id;
    main.innerHTML = `<section class="card profile" style="--c1:hsl(${hue(u.username)} 80% 60%);--c2:hsl(${(hue(u.username) + 60) % 360} 80% 55%)">
      <div class="cover"></div><div class="info">
      <div class="row">${av(u, 'lg')}${mine ? '<button class="btn ghost" id="edit">Edit profile</button>'
        : S.me ? `<button class="btn ${u.is_following ? 'ghost' : ''}" data-follow="${esc(u.username)}" data-profile>${u.is_following ? 'Following' : 'Follow'}</button>` : ''}</div>
      <h2>${esc(u.display_name)}</h2><div class="muted">@${esc(u.username)}</div>
      ${u.bio ? `<p style="margin:10px 0 0;white-space:pre-wrap;overflow-wrap:anywhere">${linkify(u.bio)}</p>` : ''}
      <div class="stats"><span><b>${u.posts}</b> posts</span><span><b id="followers">${u.followers}</b> followers</span><span><b>${u.following}</b> following</span></div>
      </div></section>
      ${posts.length ? posts.map(p => postHTML(p)).join('') : empty('No posts yet', mine ? 'Share your first post from Home.' : '')}`;
    if (mine) $('#edit').onclick = () => editProfile(u);
  } catch (e) { main.innerHTML = empty('User not found', esc(e.message)); }
}
function editProfile(u) {
  const bg = document.createElement('div'); bg.className = 'modal-bg';
  bg.innerHTML = `<form class="card modal" role="dialog" aria-modal="true" aria-label="Edit profile"><h2>Edit profile</h2>
    <label class="field"><span>Display name</span><input name="display_name" maxlength="50" value="${esc(u.display_name)}"></label>
    <label class="field"><span>Bio</span><textarea name="bio" rows="3" maxlength="160">${esc(u.bio)}</textarea></label>
    <label class="field"><span>Profile photo</span><input type="file" name="avatar" accept="image/jpeg,image/png,image/gif,image/webp"></label>
    <div class="btns"><button type="button" class="btn ghost" data-close>Cancel</button><button class="btn">Save</button></div></form>`;
  document.body.appendChild(bg);
  const close = () => bg.remove();
  bg.onclick = e => { if (e.target === bg || e.target.dataset.close !== undefined) close(); };
  bg.addEventListener('keydown', e => e.key === 'Escape' && close());
  $('input', bg).focus();
  $('form', bg).onsubmit = async e => {
    e.preventDefault();
    try { const fd = new FormData(e.target); if (!fd.get('avatar').size) fd.delete('avatar');
      await api('/me', { method: 'PUT', form: fd }); await loadMe(); close(); render(); toast('Profile updated');
    } catch (err) { toast(err.message); }
  };
}

async function postView(id) {
  const main = shell('home'); main.innerHTML = spinner;
  try {
    const p = await api('/posts/' + id);
    main.innerHTML = `<h1 class="page-title"><a class="icon-btn" href="javascript:history.back()" aria-label="Back">←</a> Post</h1>${postHTML(p, true)}`;
    loadComments($('.post'));
  } catch (e) { main.innerHTML = empty('Post not found', 'It may have been deleted.'); }
}

const notifText = { like: 'liked your post', comment: 'commented on your post', follow: 'started following you', mention: 'mentioned you' };
async function notifView() {
  if (!need()) return;
  const main = shell('notifications'); main.innerHTML = '<h1 class="page-title">Notifications</h1>' + spinner;
  try {
    const list = await api('/notifications');
    main.innerHTML = `<h1 class="page-title">Notifications</h1>` + (list.length ? `<div class="card">${list.map(n => {
      const href = n.post_id ? `#/p/${n.post_id}` : `#/u/${esc(n.actor.username)}`;
      return `<a class="notif ${n.read ? '' : 'unread'}" href="${href}">${av(n.actor, 'sm')}<div><b>${esc(n.actor.display_name)}</b> ${notifText[n.type] || 'interacted with you'} <span class="muted">· ${ago(n.created_at)}</span>
        ${n.snippet ? `<div class="snip">${esc(n.snippet)}</div>` : ''}</div></a>`; }).join('')}</div>` : empty('All quiet', 'Likes, comments, follows and mentions will appear here.'));
    if (list.some(n => !n.read)) { await api('/notifications/read', { method: 'POST' }); updateBadge(0); S.me.unread = 0; }
  } catch (e) { main.innerHTML = empty('Couldn’t load', esc(e.message)); }
}

// ---------- comments ----------
function commentHTML(c) {
  return `<div class="comment" data-comment="${c.id}"><a href="#/u/${esc(c.author.username)}">${av(c.author, 'sm')}</a>
    <div class="bubble"><b><a href="#/u/${esc(c.author.username)}">${esc(c.author.display_name)}</a></b> <span class="muted">${ago(c.created_at)}</span>
    ${S.me && S.me.id === c.author.id ? ` <button class="icon-btn" style="width:24px;height:24px;display:inline-grid;vertical-align:middle" data-act="del-comment" aria-label="Delete comment">×</button>` : ''}
    <div>${linkify(c.text)}</div></div></div>`;
}
async function loadComments(card) {
  const box = $('.comments', card), id = card.dataset.post;
  box.classList.remove('hidden'); box.innerHTML = spinner;
  try {
    const list = await api(`/posts/${id}/comments`);
    box.innerHTML = `<div class="clist">${list.map(commentHTML).join('') || '<p class="muted" style="margin:0 0 10px">No comments yet.</p>'}</div>` +
      (S.me ? `<form class="cform"><input name="text" maxlength="300" placeholder="Write a comment…" aria-label="Comment" autocomplete="off"><button class="btn sm">Send</button></form>` : '<p class="muted"><a href="#/login" style="color:var(--accent)">Log in</a> to comment.</p>');
    const form = $('.cform', box);
    if (form) form.onsubmit = async e => {
      e.preventDefault(); const text = form.text.value.trim(); if (!text) return;
      try {
        const c = await api(`/posts/${id}/comments`, { method: 'POST', body: { text } });
        const l = $('.clist', box); l.querySelector('p')?.remove(); l.insertAdjacentHTML('beforeend', commentHTML(c)); form.reset();
        setCount(card, 'comments', 1);
      } catch (err) { toast(err.message); }
    };
  } catch (e) { box.innerHTML = `<p class="muted">${esc(e.message)}</p>`; }
}
function setCount(card, act, delta) {
  const s = $(`[data-act="${act}"] span`, card); s.textContent = Math.max(0, (parseInt(s.textContent) || 0) + delta) || '';
}

// ---------- global events ----------
document.addEventListener('click', async e => {
  const t = e.target.closest('[data-act],[data-follow],[data-logout]'); if (!t) return;
  if (t.dataset.logout !== undefined) { e.preventDefault(); return logout(); }
  if (t.dataset.follow) {
    if (!need()) return;
    try {
      const r = await api(`/users/${encodeURIComponent(t.dataset.follow)}/follow`, { method: 'POST' });
      t.textContent = r.following ? 'Following' : 'Follow'; t.classList.toggle('ghost', r.following);
      if (t.dataset.profile !== undefined) $('#followers').textContent = r.followers;
    } catch (err) { toast(err.message); }
    return;
  }
  const card = t.closest('.post'), id = card && card.dataset.post, act = t.dataset.act;
  if (act === 'like') {
    if (!need()) return;
    try {
      const r = await api(`/posts/${id}/like`, { method: 'POST' });
      t.classList.toggle('liked', r.liked); t.setAttribute('aria-pressed', r.liked); $('span', t).textContent = r.like_count || '';
    } catch (err) { toast(err.message); }
  } else if (act === 'comments') {
    const box = $('.comments', card);
    if (box.classList.contains('hidden')) loadComments(card); else box.classList.add('hidden');
  } else if (act === 'delete') {
    if (!confirm('Delete this post?')) return;
    try { await api('/posts/' + id, { method: 'DELETE' }); card.remove(); toast('Post deleted'); } catch (err) { toast(err.message); }
  } else if (act === 'del-comment') {
    const c = t.closest('.comment');
    try { await api('/comments/' + c.dataset.comment, { method: 'DELETE' }); c.remove(); setCount(card, 'comments', -1); } catch (err) { toast(err.message); }
  }
});
let st;
document.addEventListener('input', e => {
  if (e.target.id !== 'q') return;
  clearTimeout(st);
  st = setTimeout(async () => {
    const box = $('#results'), q = e.target.value.trim();
    if (!q) return box.classList.add('hidden');
    try { const r = await api('/users/search?q=' + encodeURIComponent(q));
      box.innerHTML = r.length ? r.map(userRow).join('') : '<p class="muted" style="padding:12px 18px;margin:0">No people found</p>'; box.classList.remove('hidden');
    } catch {}
  }, 250);
});
document.addEventListener('mousedown', e => { if (!e.target.closest('.search')) $('#results')?.classList.add('hidden'); });

// ---------- router ----------
async function loadMe() {
  if (!S.token) { S.me = null; return; }
  try { S.me = await api('/me'); } catch { S.me = null; }
  clearInterval(S.pollTimer);
  if (S.me) S.pollTimer = setInterval(async () => {
    if (document.hidden) return;
    try { const c = await api('/notifications/count'); S.me.unread = c.unread; updateBadge(c.unread); } catch {}
  }, 20000);
}
function render() {
  const h = location.hash.replace(/^#\/?/, ''), [a, b] = h.split('/').map(decodeURIComponent);
  window.scrollTo(0, 0);
  if (a === 'login' || a === 'register') return S.me ? (location.hash = '#/') : authView(a);
  if (a === 'explore') return exploreView();
  if (a === 'tag' && b) return tagView(b);
  if (a === 'u' && b) return profileView(b);
  if (a === 'p' && b) return postView(b);
  if (a === 'notifications') return notifView();
  return homeView();
}
window.addEventListener('hashchange', render);
loadMe().then(render);
})();
