'use strict';
const session = require('express-session');

const DEFAULT_TTL_MS = 8 * 60 * 60 * 1000;

// Persists sessions in SQLite so sign-ins survive an app restart
class SqliteSessionStore extends session.Store {
  constructor(db) {
    super();
    this.getStmt     = db.prepare('SELECT sess, expires FROM sessions WHERE sid = ?');
    this.setStmt     = db.prepare(`INSERT INTO sessions (sid, sess, expires) VALUES (?, ?, ?)
                                   ON CONFLICT(sid) DO UPDATE SET sess = excluded.sess, expires = excluded.expires`);
    this.destroyStmt = db.prepare('DELETE FROM sessions WHERE sid = ?');
    this.touchStmt   = db.prepare('UPDATE sessions SET expires = ? WHERE sid = ?');
    const purge      = db.prepare('DELETE FROM sessions WHERE expires < ?');
    setInterval(() => purge.run(Date.now()), 15 * 60 * 1000).unref();
  }

  static expiry(sess) {
    return sess?.cookie?.expires ? new Date(sess.cookie.expires).getTime() : Date.now() + DEFAULT_TTL_MS;
  }

  get(sid, cb) {
    try {
      const row = this.getStmt.get(sid);
      if (!row || row.expires < Date.now()) return cb(null, null);
      cb(null, JSON.parse(row.sess));
    } catch (err) { cb(err); }
  }

  set(sid, sess, cb) {
    try {
      this.setStmt.run(sid, JSON.stringify(sess), SqliteSessionStore.expiry(sess));
      cb?.(null);
    } catch (err) { cb?.(err); }
  }

  destroy(sid, cb) {
    try { this.destroyStmt.run(sid); cb?.(null); } catch (err) { cb?.(err); }
  }

  touch(sid, sess, cb) {
    try { this.touchStmt.run(SqliteSessionStore.expiry(sess), sid); cb?.(null); } catch (err) { cb?.(err); }
  }
}

module.exports = SqliteSessionStore;
