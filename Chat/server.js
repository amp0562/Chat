const express = require("express");
const http = require("http");
const multer = require("multer");
const { Server } = require("socket.io");
const session = require("express-session");
const Database = require("better-sqlite3");
const db = new Database("./db.sqlite");

const app = express();
const server = http.createServer(app);
const io = new Server(server);

app.use(express.json());
app.use(express.static("public"));
app.use("/uploads", express.static("uploads"));

app.set("trust proxy", 1); // trust first proxy

app.use(session({
  secret: process.env.SESSION_SECRET,
  resave: false,
  saveUninitialized: false,
  cookie: {
    secure: true,      // required on HTTPS (Render uses HTTPS)
    sameSite: "none"   // required for cross-site (frontend + backend split)
  }
}));

/* ===== DB SETUP ===== */

db.prepare(`
CREATE TABLE IF NOT EXISTS users (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  username TEXT UNIQUE,
  password TEXT,
  avatar TEXT
)`).run();

db.prepare(`
CREATE TABLE IF NOT EXISTS messages (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  sender TEXT,
  receiver TEXT,
  text TEXT,
  timestamp INTEGER
)`).run();

db.prepare(`
CREATE TABLE IF NOT EXISTS friends (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user1 TEXT,
  user2 TEXT
)`).run();

db.prepare(`
CREATE TABLE IF NOT EXISTS friend_requests (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  sender TEXT,
  receiver TEXT
)`).run();

/* ===== AUTH ===== */

app.get("/me", (req, res) => {

  const user = req.session.user;

  if (!user) return res.json({ user: null });

  const row = db.prepare("SELECT username, avatar FROM users WHERE username = ?").get(user);

  res.json({ user: row });
});

app.post("/register", (req, res) => {
  const { username, password } = req.body;

  const avatar = `https://api.dicebear.com/6.x/initials/svg?seed=${username}`;

  db.prepare("INSERT INTO users (username, password, avatar) VALUES (?, ?, ?)").run(username, password, avatar);

  res.json({ ok: true });
});

app.post("/login", (req, res) => {
  const { username, password } = req.body;

  const row = db.prepare("SELECT * FROM users WHERE username=? AND password=?").get(username, password);

  if (row) {
    req.session.user = username;
    res.json({ ok: true });
  } else {
    res.json({ ok: false });
  }
});

app.post("/logout", (req, res) => {
  req.session.destroy(() => res.json({ ok: true }));
});

/* ===== FRIEND SYSTEM ===== */

app.post("/add-friend", (req, res) => {
  const sender = req.session.user;
  const { receiver } = req.body;

  if (!sender) return res.sendStatus(401);

  db.prepare("INSERT INTO friend_requests (sender, receiver) VALUES (?, ?)").run(sender, receiver);

  res.json({ ok: true });
});

app.get("/pending", (req, res) => {
  const user = req.session.user;

  const rows = db.prepare("SELECT sender FROM friend_requests WHERE receiver = ?").all(user);

  res.json(rows.map(r => r.sender));
});

app.get("/friend-requests", (req, res) => {
  const user = req.session.user;

  const rows = db.prepare("SELECT * FROM friend_requests WHERE receiver=?").all(user);

  res.json(rows);
});

app.post("/accept-friend", (req, res) => {
  const user = req.session.user;
  const { sender } = req.body;

  db.prepare("INSERT INTO friends (user1, user2) VALUES (?, ?)").run(sender, user);

  db.prepare("DELETE FROM friend_requests WHERE sender=? AND receiver=?").run(sender, user);

  res.json({ ok: true });
});

app.get("/friends", (req, res) => {
  const user = req.session.user;

  try {
  const rows = db.prepare(`
    SELECT 
      CASE 
        WHEN f.user1 = ? THEN u2.username 
        ELSE u1.username 
      END AS username,

      CASE 
        WHEN f.user1 = ? THEN u2.avatar 
        ELSE u1.avatar 
      END AS avatar

    FROM friends f
    JOIN users u1 ON f.user1 = u1.username
    JOIN users u2 ON f.user2 = u2.username

    WHERE f.user1 = ? OR f.user2 = ?
  `).all(user, user, user, user);

  res.json(rows);
} catch (err) {
  console.error(err);
  res.sendStatus(500);
}
});

const storage = multer.diskStorage({
  destination: (req, file, cb) => {
    cb(null, "uploads/");
  },
  filename: (req, file, cb) => {
    cb(null, Date.now() + "-" + file.originalname);
  }
});

const upload = multer({ storage });

app.post("/set-avatar", upload.single("avatar"), (req, res) => {
  const user = req.session.user;

  if (!user) {
    return res.status(401).json({ error: "Not logged in" });
  }

  if (!req.file) {
    return res.status(400).json({ error: "No file uploaded" });
  }

  const filePath = "/uploads/" + req.file.filename;

  console.log("Saving avatar:", filePath, "for user:", user);

  try {
    db.prepare("UPDATE users SET avatar = ? WHERE username = ?").run(filePath, user);

    res.json({ok: true,avatar: filePath});
  } catch (err) {
    console.error("DB error:", err);
    res.status(500).json({ error: "Database failed" });
  }
});

/* ===== MESSAGES ===== */

app.get("/messages", (req, res) => {
    const user = req.session.user;
    const withUser = req.query.withUser;

    const rows = db.prepare(`
    SELECT messages.*, users.avatar 
    FROM messages 
    JOIN users ON users.username = messages.sender
    WHERE (sender=? AND receiver=?) 
    OR (sender=? AND receiver=?)
  `).all(user, withUser, withUser, user);

  res.json(rows);
});

/* ===== SOCKET ===== */

io.on("connection", (socket) => {
  socket.on("sendMessage", (msg) => {
    
    db.prepare("INSERT INTO messages (sender, receiver, text, timestamp) VALUES (?, ?, ?, ?)").run(msg.sender, msg.to, msg.text, Date.now());

  const row = db.prepare("SELECT avatar FROM users WHERE username = ?").get(msg.sender);

  io.emit("newMessage", {
    avatar: row ? row.avatar : `https://api.dicebear.com/7.x/initials/svg?seed=${msg.sender}`,
    sender: msg.sender,
    receiver: msg.to,
    text: msg.text,
    timestamp: Date.now()
  });
});

server.listen(3000, () => console.log("running on 3000"));
