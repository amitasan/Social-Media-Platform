const express = require('express');
const { DatabaseSync } = require('node:sqlite');

// Thin wrapper giving node:sqlite the small API surface used below (pragma, transaction,
// named params ignoring unused keys). Built into Node, so no native compile step is needed.
class Database {
  constructor(file) { this.d = new DatabaseSync(file); }
  pragma(s) { this.d.exec('PRAGMA ' + s); }
  exec(s) { this.d.exec(s); }
  prepare(sql) {
    const st = this.d.prepare(sql);
    const names = [...new Set([...sql.matchAll(/@([A-Za-z_]\w*)/g)].map(m => m[1]))];
    const bind = a => {
      if (a.length === 1 && a[0] && typeof a[0] === 'object' && !Array.isArray(a[0])) {
        const o = {}; for (const n of names) o[n] = a[0][n] === undefined ? null : a[0][n]; return [o];
      }
      return a.map(v => v === undefined ? null : v);
    };
    return { get: (...a) => st.get(...bind(a)), all: (...a) => st.all(...bind(a)), run: (...a) => st.run(...bind(a)) };
  }
  transaction(fn) {
    return (...a) => { this.d.exec('BEGIN'); try { const r = fn(...a); this.d.exec('COMMIT'); return r; } catch (e) { this.d.exec('ROLLBACK'); throw e; } };
  }
}
const multer = require('multer');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');

const PORT = process.env.PORT || 3000;
const DATA_DIR = process.env.DATA_DIR || __dirname;
const UPLOAD_DIR = path.join(DATA_DIR, 'uploads');
fs.mkdirSync(UPLOAD_DIR, { recursive: true });

// JWT secret: from env, or generated once and persisted next to the DB
const secretFile = path.join(DATA_DIR, '.jwt-secret');
const JWT_SECRET = process.env.JWT_SECRET ||
  (fs.existsSync(secretFile) ? fs.readFileSync(secretFile, 'utf8') :
    (() => { const s = crypto.randomBytes(32).toString('hex'); fs.writeFileSync(secretFile, s, { mode: 0o600 }); return s; })());

const db = new Database(path.join(DATA_DIR, 'social.db'));
db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');
db.exec(`
CREATE TABLE IF NOT EXISTS users(
  id INTEGER PRIMARY KEY, username TEXT UNIQUE NOT NULL COLLATE NOCASE,
  display_name TEXT NOT NULL, bio TEXT DEFAULT '', avatar TEXT,
  password_hash TEXT NOT NULL, created_at INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS posts(
  id INTEGER PRIMARY KEY, user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  text TEXT NOT NULL DEFAULT '', media_path TEXT, media_type TEXT, created_at INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS post_tags(
  post_id INTEGER NOT NULL REFERENCES posts(id) ON DELETE CASCADE, tag TEXT NOT NULL,
  PRIMARY KEY(post_id, tag));
CREATE INDEX IF NOT EXISTS idx_tag ON post_tags(tag);
CREATE TABLE IF NOT EXISTS likes(
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  post_id INTEGER NOT NULL REFERENCES posts(id) ON DELETE CASCADE,
  created_at INTEGER NOT NULL, PRIMARY KEY(user_id, post_id));
CREATE TABLE IF NOT EXISTS comments(
  id INTEGER PRIMARY KEY, post_id INTEGER NOT NULL REFERENCES posts(id) ON DELETE CASCADE,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  text TEXT NOT NULL, created_at INTEGER NOT NULL);
CREATE INDEX IF NOT EXISTS idx_comments_post ON comments(post_id);
CREATE TABLE IF NOT EXISTS follows(
  follower_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  followee_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at INTEGER NOT NULL, PRIMARY KEY(follower_id, followee_id));
CREATE TABLE IF NOT EXISTS notifications(
  id INTEGER PRIMARY KEY, user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  actor_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  type TEXT NOT NULL, post_id INTEGER REFERENCES posts(id) ON DELETE CASCADE,
  read INTEGER NOT NULL DEFAULT 0, created_at INTEGER NOT NULL);
CREATE INDEX IF NOT EXISTS idx_notif_user ON notifications(user_id, read);
`);

const app = express();
app.use(express.json({ limit: '100kb' }));
app.use('/uploads', express.static(UPLOAD_DIR, { maxAge: '7d', setHeaders: r => r.setHeader('X-Content-Type-Options', 'nosniff') }));
app.use(express.static(path.join(__dirname, 'public')));

// ---------- helpers ----------
const now = () => Date.now();
const MIME = {
  'image/jpeg': ['.jpg', 'image'], 'image/png': ['.png', 'image'], 'image/gif': ['.gif', 'image'],
  'image/webp': ['.webp', 'image'], 'video/mp4': ['.mp4', 'video'], 'video/webm': ['.webm', 'video'],
  'video/quicktime': ['.mov', 'video'],
};
const upload = multer({
  storage: multer.diskStorage({
    destination: UPLOAD_DIR,
    filename: (req, file, cb) => cb(null, crypto.randomBytes(16).toString('hex') + MIME[file.mimetype][0]),
  }),
  limits: { fileSize: 50 * 1024 * 1024, files: 1 },
  fileFilter: (req, file, cb) => MIME[file.mimetype] ? cb(null, true) : cb(new Error('Unsupported file type')),
});
const rm = f => { if (f) fs.unlink(path.join(UPLOAD_DIR, path.basename(f)), () => {}); };
const wrap = fn => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);

function auth(required = true) {
  return (req, res, next) => {
    const h = req.headers.authorization || '';
    const token = h.startsWith('Bearer ') ? h.slice(7) : null;
    if (token) {
      try {
        const { id } = jwt.verify(token, JWT_SECRET);
        const u = db.prepare('SELECT id, username FROM users WHERE id=?').get(id);
        if (u) { req.user = u; return next(); }
      } catch {}
    }
    if (required) return res.status(401).json({ error: 'Please log in' });
    next();
  };
}
const sign = u => jwt.sign({ id: u.id }, JWT_SECRET, { expiresIn: '30d' });

function notify(userId, actorId, type, postId = null) {
  if (userId === actorId) return;
  // de-duplicate identical unread notifications (e.g. like/unlike spam)
  const dup = db.prepare('SELECT id FROM notifications WHERE user_id=? AND actor_id=? AND type=? AND post_id IS ? AND read=0').get(userId, actorId, type, postId);
  if (type !== 'comment' && type !== 'mention' && dup) return;
  db.prepare('INSERT INTO notifications(user_id,actor_id,type,post_id,created_at) VALUES(?,?,?,?,?)').run(userId, actorId, type, postId, now());
}

const extractTags = text => [...new Set((text.match(/#([\p{L}\p{N}_]{1,40})/gu) || []).map(t => t.slice(1).toLowerCase()))];
const extractMentions = text => [...new Set((text.match(/@([A-Za-z0-9_]{3,20})/g) || []).map(t => t.slice(1).toLowerCase()))];

const POST_SELECT = `
SELECT p.id, p.text, p.media_path, p.media_type, p.created_at,
  u.id AS user_id, u.username, u.display_name, u.avatar,
  (SELECT COUNT(*) FROM likes l WHERE l.post_id=p.id) AS like_count,
  (SELECT COUNT(*) FROM comments c WHERE c.post_id=p.id) AS comment_count,
  EXISTS(SELECT 1 FROM likes l WHERE l.post_id=p.id AND l.user_id=@me) AS liked,
  (SELECT group_concat(tag) FROM post_tags t WHERE t.post_id=p.id) AS tags
FROM posts p JOIN users u ON u.id=p.user_id`;
const shapePost = r => ({
  id: r.id, text: r.text, created_at: r.created_at,
  media: r.media_path ? { url: '/uploads/' + r.media_path, type: r.media_type } : null,
  author: { id: r.user_id, username: r.username, display_name: r.display_name, avatar: r.avatar ? '/uploads/' + r.avatar : null },
  like_count: r.like_count, comment_count: r.comment_count, liked: !!r.liked,
  tags: r.tags ? r.tags.split(',') : [],
});
const meId = req => req.user ? req.user.id : 0;
const shapeUser = (u, me) => ({
  id: u.id, username: u.username, display_name: u.display_name, bio: u.bio,
  avatar: u.avatar ? '/uploads/' + u.avatar : null, created_at: u.created_at,
  followers: db.prepare('SELECT COUNT(*) c FROM follows WHERE followee_id=?').get(u.id).c,
  following: db.prepare('SELECT COUNT(*) c FROM follows WHERE follower_id=?').get(u.id).c,
  posts: db.prepare('SELECT COUNT(*) c FROM posts WHERE user_id=?').get(u.id).c,
  is_following: !!me && !!db.prepare('SELECT 1 FROM follows WHERE follower_id=? AND followee_id=?').get(me, u.id),
});

// ---------- auth ----------
app.post('/api/auth/register', wrap((req, res) => {
  const { username = '', password = '', display_name = '' } = req.body;
  if (!/^[A-Za-z0-9_]{3,20}$/.test(username)) return res.status(400).json({ error: 'Username must be 3-20 letters, numbers or underscores' });
  if (password.length < 8) return res.status(400).json({ error: 'Password must be at least 8 characters' });
  if (db.prepare('SELECT 1 FROM users WHERE username=?').get(username)) return res.status(409).json({ error: 'Username already taken' });
  const info = db.prepare('INSERT INTO users(username,display_name,password_hash,created_at) VALUES(?,?,?,?)')
    .run(username, display_name.trim().slice(0, 50) || username, bcrypt.hashSync(password, 10), now());
  const u = db.prepare('SELECT * FROM users WHERE id=?').get(info.lastInsertRowid);
  res.json({ token: sign(u), user: shapeUser(u, 0) });
}));
app.post('/api/auth/login', wrap((req, res) => {
  const { username = '', password = '' } = req.body;
  const u = db.prepare('SELECT * FROM users WHERE username=?').get(username);
  if (!u || !bcrypt.compareSync(password, u.password_hash)) return res.status(401).json({ error: 'Invalid username or password' });
  res.json({ token: sign(u), user: shapeUser(u, 0) });
}));
app.get('/api/me', auth(), wrap((req, res) => {
  const u = db.prepare('SELECT * FROM users WHERE id=?').get(req.user.id);
  res.json({ ...shapeUser(u, 0), unread: db.prepare('SELECT COUNT(*) c FROM notifications WHERE user_id=? AND read=0').get(u.id).c });
}));
app.put('/api/me', auth(), upload.single('avatar'), wrap((req, res) => {
  const u = db.prepare('SELECT * FROM users WHERE id=?').get(req.user.id);
  if (req.file && req.file.mimetype.startsWith('video/')) { rm(req.file.filename); return res.status(400).json({ error: 'Avatar must be an image' }); }
  const display = (req.body.display_name ?? u.display_name).trim().slice(0, 50) || u.username;
  const bio = (req.body.bio ?? u.bio).slice(0, 160);
  let avatar = u.avatar;
  if (req.file) { rm(u.avatar); avatar = req.file.filename; }
  db.prepare('UPDATE users SET display_name=?, bio=?, avatar=? WHERE id=?').run(display, bio, avatar, u.id);
  res.json(shapeUser(db.prepare('SELECT * FROM users WHERE id=?').get(u.id), 0));
}));

// ---------- users ----------
app.get('/api/users/search', auth(false), wrap((req, res) => {
  const q = String(req.query.q || '').trim().replace(/[%_]/g, '');
  if (!q) return res.json([]);
  const rows = db.prepare('SELECT * FROM users WHERE username LIKE ? OR display_name LIKE ? ORDER BY username LIMIT 15').all(q + '%', '%' + q + '%');
  res.json(rows.map(u => shapeUser(u, meId(req))));
}));
app.get('/api/users/suggestions', auth(), wrap((req, res) => {
  const rows = db.prepare(`SELECT u.* FROM users u WHERE u.id!=? AND u.id NOT IN (SELECT followee_id FROM follows WHERE follower_id=?)
    ORDER BY (SELECT COUNT(*) FROM follows f WHERE f.followee_id=u.id) DESC, u.created_at DESC LIMIT 5`).all(req.user.id, req.user.id);
  res.json(rows.map(u => shapeUser(u, req.user.id)));
}));
app.get('/api/users/:username', auth(false), wrap((req, res) => {
  const u = db.prepare('SELECT * FROM users WHERE username=?').get(req.params.username);
  if (!u) return res.status(404).json({ error: 'User not found' });
  res.json(shapeUser(u, meId(req)));
}));
app.get('/api/users/:username/posts', auth(false), wrap((req, res) => {
  const u = db.prepare('SELECT id FROM users WHERE username=?').get(req.params.username);
  if (!u) return res.status(404).json({ error: 'User not found' });
  const rows = db.prepare(POST_SELECT + ' WHERE p.user_id=@uid ORDER BY p.id DESC LIMIT 50').all({ me: meId(req), uid: u.id });
  res.json(rows.map(shapePost));
}));
app.post('/api/users/:username/follow', auth(), wrap((req, res) => {
  const u = db.prepare('SELECT id FROM users WHERE username=?').get(req.params.username);
  if (!u) return res.status(404).json({ error: 'User not found' });
  if (u.id === req.user.id) return res.status(400).json({ error: "You can't follow yourself" });
  const ex = db.prepare('SELECT 1 FROM follows WHERE follower_id=? AND followee_id=?').get(req.user.id, u.id);
  if (ex) db.prepare('DELETE FROM follows WHERE follower_id=? AND followee_id=?').run(req.user.id, u.id);
  else { db.prepare('INSERT INTO follows VALUES(?,?,?)').run(req.user.id, u.id, now()); notify(u.id, req.user.id, 'follow'); }
  res.json({ following: !ex, followers: db.prepare('SELECT COUNT(*) c FROM follows WHERE followee_id=?').get(u.id).c });
}));

// ---------- posts ----------
app.get('/api/feed', auth(false), wrap((req, res) => {
  const me = meId(req);
  const before = parseInt(req.query.before) || 9e15;
  const tag = String(req.query.tag || '').toLowerCase().replace(/^#/, '');
  const scope = req.query.scope === 'following' && me ? 'following' : 'all';
  let where = 'p.id < @before';
  if (tag) where += ' AND EXISTS(SELECT 1 FROM post_tags t WHERE t.post_id=p.id AND t.tag=@tag)';
  if (scope === 'following') where += ' AND (p.user_id=@me OR p.user_id IN (SELECT followee_id FROM follows WHERE follower_id=@me))';
  const rows = db.prepare(`${POST_SELECT} WHERE ${where} ORDER BY p.id DESC LIMIT 20`).all({ me, before, tag });
  res.json(rows.map(shapePost));
}));
app.get('/api/posts/:id', auth(false), wrap((req, res) => {
  const r = db.prepare(POST_SELECT + ' WHERE p.id=@id').get({ me: meId(req), id: req.params.id });
  if (!r) return res.status(404).json({ error: 'Post not found' });
  res.json(shapePost(r));
}));
app.post('/api/posts', auth(), upload.single('media'), wrap((req, res) => {
  const text = String(req.body.text || '').trim().slice(0, 500);
  if (!text && !req.file) return res.status(400).json({ error: 'Write something or attach media' });
  const extra = String(req.body.tags || '').split(/[\s,]+/).map(t => t.replace(/^#/, '').toLowerCase()).filter(t => /^[\p{L}\p{N}_]{1,40}$/u.test(t));
  const tags = [...new Set([...extractTags(text), ...extra])].slice(0, 10);
  const info = db.transaction(() => {
    const i = db.prepare('INSERT INTO posts(user_id,text,media_path,media_type,created_at) VALUES(?,?,?,?,?)')
      .run(req.user.id, text, req.file ? req.file.filename : null, req.file ? MIME[req.file.mimetype][1] : null, now());
    for (const t of tags) db.prepare('INSERT OR IGNORE INTO post_tags VALUES(?,?)').run(i.lastInsertRowid, t);
    return i;
  })();
  // user tagging via @mentions
  for (const name of extractMentions(text)) {
    const m = db.prepare('SELECT id FROM users WHERE username=?').get(name);
    if (m) notify(m.id, req.user.id, 'mention', info.lastInsertRowid);
  }
  const r = db.prepare(POST_SELECT + ' WHERE p.id=@id').get({ me: req.user.id, id: info.lastInsertRowid });
  res.json(shapePost(r));
}));
app.delete('/api/posts/:id', auth(), wrap((req, res) => {
  const p = db.prepare('SELECT * FROM posts WHERE id=?').get(req.params.id);
  if (!p) return res.status(404).json({ error: 'Post not found' });
  if (p.user_id !== req.user.id) return res.status(403).json({ error: 'Not your post' });
  db.prepare('DELETE FROM posts WHERE id=?').run(p.id);
  rm(p.media_path);
  res.json({ ok: true });
}));
app.post('/api/posts/:id/like', auth(), wrap((req, res) => {
  const p = db.prepare('SELECT id, user_id FROM posts WHERE id=?').get(req.params.id);
  if (!p) return res.status(404).json({ error: 'Post not found' });
  const ex = db.prepare('SELECT 1 FROM likes WHERE user_id=? AND post_id=?').get(req.user.id, p.id);
  if (ex) db.prepare('DELETE FROM likes WHERE user_id=? AND post_id=?').run(req.user.id, p.id);
  else { db.prepare('INSERT INTO likes VALUES(?,?,?)').run(req.user.id, p.id, now()); notify(p.user_id, req.user.id, 'like', p.id); }
  res.json({ liked: !ex, like_count: db.prepare('SELECT COUNT(*) c FROM likes WHERE post_id=?').get(p.id).c });
}));

// ---------- comments ----------
const shapeComment = r => ({ id: r.id, text: r.text, created_at: r.created_at, post_id: r.post_id,
  author: { id: r.user_id, username: r.username, display_name: r.display_name, avatar: r.avatar ? '/uploads/' + r.avatar : null } });
const COMMENT_SELECT = 'SELECT c.*, u.username, u.display_name, u.avatar FROM comments c JOIN users u ON u.id=c.user_id';
app.get('/api/posts/:id/comments', wrap((req, res) => {
  res.json(db.prepare(COMMENT_SELECT + ' WHERE c.post_id=? ORDER BY c.id ASC LIMIT 200').all(req.params.id).map(shapeComment));
}));
app.post('/api/posts/:id/comments', auth(), wrap((req, res) => {
  const p = db.prepare('SELECT id, user_id FROM posts WHERE id=?').get(req.params.id);
  if (!p) return res.status(404).json({ error: 'Post not found' });
  const text = String(req.body.text || '').trim().slice(0, 300);
  if (!text) return res.status(400).json({ error: 'Comment is empty' });
  const i = db.prepare('INSERT INTO comments(post_id,user_id,text,created_at) VALUES(?,?,?,?)').run(p.id, req.user.id, text, now());
  notify(p.user_id, req.user.id, 'comment', p.id);
  for (const name of extractMentions(text)) {
    const m = db.prepare('SELECT id FROM users WHERE username=?').get(name);
    if (m && m.id !== p.user_id) notify(m.id, req.user.id, 'mention', p.id);
  }
  res.json(shapeComment(db.prepare(COMMENT_SELECT + ' WHERE c.id=?').get(i.lastInsertRowid)));
}));
app.delete('/api/comments/:id', auth(), wrap((req, res) => {
  const c = db.prepare('SELECT c.*, p.user_id AS post_owner FROM comments c JOIN posts p ON p.id=c.post_id WHERE c.id=?').get(req.params.id);
  if (!c) return res.status(404).json({ error: 'Comment not found' });
  if (c.user_id !== req.user.id && c.post_owner !== req.user.id) return res.status(403).json({ error: 'Not allowed' });
  db.prepare('DELETE FROM comments WHERE id=?').run(c.id);
  res.json({ ok: true });
}));

// ---------- explore / trending ----------
app.get('/api/trending', auth(false), wrap((req, res) => {
  const week = now() - 7 * 864e5;
  const tags = db.prepare(`SELECT t.tag, COUNT(*) AS posts FROM post_tags t JOIN posts p ON p.id=t.post_id
    WHERE p.created_at > ? GROUP BY t.tag ORDER BY posts DESC, MAX(p.created_at) DESC LIMIT 10`).all(week);
  // score = likes + 2*comments, decayed by age in hours (gravity-style)
  const rows = db.prepare(`${POST_SELECT} WHERE p.created_at > @since
    ORDER BY ((SELECT COUNT(*) FROM likes l WHERE l.post_id=p.id) + 2*(SELECT COUNT(*) FROM comments c WHERE c.post_id=p.id) + 1)
      / POWER(((@now - p.created_at)/3600000.0) + 2, 1.5) DESC LIMIT 20`).all({ me: meId(req), since: week, now: now() });
  res.json({ tags, posts: rows.map(shapePost) });
}));

// ---------- notifications ----------
app.get('/api/notifications', auth(), wrap((req, res) => {
  const rows = db.prepare(`SELECT n.*, u.username, u.display_name, u.avatar, substr(p.text,1,80) AS snippet
    FROM notifications n JOIN users u ON u.id=n.actor_id LEFT JOIN posts p ON p.id=n.post_id
    WHERE n.user_id=? ORDER BY n.id DESC LIMIT 50`).all(req.user.id);
  res.json(rows.map(r => ({ id: r.id, type: r.type, post_id: r.post_id, read: !!r.read, created_at: r.created_at, snippet: r.snippet,
    actor: { username: r.username, display_name: r.display_name, avatar: r.avatar ? '/uploads/' + r.avatar : null } })));
}));
app.get('/api/notifications/count', auth(), wrap((req, res) => {
  res.json({ unread: db.prepare('SELECT COUNT(*) c FROM notifications WHERE user_id=? AND read=0').get(req.user.id).c });
}));
app.post('/api/notifications/read', auth(), wrap((req, res) => {
  db.prepare('UPDATE notifications SET read=1 WHERE user_id=?').run(req.user.id);
  res.json({ ok: true });
}));

// ---------- errors ----------
app.use('/api', (req, res) => res.status(404).json({ error: 'Not found' }));
app.use((err, req, res, next) => {
  if (req.file) rm(req.file.filename);
  const msg = err.code === 'LIMIT_FILE_SIZE' ? 'File too large (max 50 MB)' : err.message;
  const status = err instanceof multer.MulterError || /Unsupported/.test(err.message) ? 400 : 500;
  if (status === 500) console.error(err);
  res.status(status).json({ error: status === 500 ? 'Server error' : msg });
});

if (require.main === module) app.listen(PORT, () => console.log(`Sparkle running at http://localhost:${PORT}`));
module.exports = app;
