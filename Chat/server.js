const express = require("express");
const http = require("http");
const multer = require("multer");
const { Server } = require("socket.io");
const session = require("express-session");
const sqlite3 = require("sqlite3").verbose();

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

const db = new sqlite3.Database("./db.sqlite");

/* ===== DB SETUP ===== */

db.run(`
CREATE TABLE IF NOT EXISTS users (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  username TEXT UNIQUE,
  password TEXT,
  avatar TEXT
)`);

db.run(`
CREATE TABLE IF NOT EXISTS messages (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  sender TEXT,
  receiver TEXT,
  text TEXT,
  timestamp INTEGER
)`); 

db.run(`
CREATE TABLE IF NOT EXISTS friends (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user1 TEXT,
  user2 TEXT
)`);

db.run(`
CREATE TABLE IF NOT EXISTS friend_requests (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  sender TEXT,
  receiver TEXT
)`);

/* ===== AUTH ===== */

app.get("/me", (req, res) => {

  const user = req.session.user;

  if (!user) return res.json({ user: null });

  db.get(
    "SELECT username, avatar FROM users WHERE username = ?",
    [user],
    (err, row) => {
      res.json({ user: row });
    }
  );
});

app.post("/register", (req, res) => {
  const { username, password } = req.body;

  const avatar = `https://api.dicebear.com/6.x/initials/svg?seed=${username}`;

  db.run(
    "INSERT INTO users (username, password, avatar) VALUES (?, ?, ?)",
    [username, password, avatar],
    () => res.json({ ok: true })
  );
});

app.post("/login", (req, res) => {
  const { username, password } = req.body;

  db.get(
    "SELECT * FROM users WHERE username=? AND password=?",
    [username, password],
    (err, row) => {
      if (row) {
        req.session.user = username;
        res.json({ ok: true });
      } else {
        res.json({ ok: false });
      }
    }
  );
});

app.post("/logout", (req, res) => {
  req.session.destroy(() => res.json({ ok: true }));
});

/* ===== FRIEND SYSTEM ===== */

app.post("/add-friend", (req, res) => {
  const sender = req.session.user;
  const { receiver } = req.body;

  if (!sender) return res.sendStatus(401);

  db.run(
    "INSERT INTO friend_requests (sender, receiver) VALUES (?, ?)",
    [sender, receiver],
    () => res.json({ ok: true })
  );
});

app.get("/pending", (req, res) => {
  const user = req.session.user;

  db.all(
    "SELECT sender FROM friend_requests WHERE receiver = ?",
    [user],
    (err, rows) => {
      if (err) return res.json([]);
      res.json(rows.map(r => r.sender));
    }
  );
});

app.get("/friend-requests", (req, res) => {
  const user = req.session.user;

  db.all(
    "SELECT * FROM friend_requests WHERE receiver=?",
    [user],
    (err, rows) => res.json(rows)
  );
});

app.post("/accept-friend", (req, res) => {
  const user = req.session.user;
  const { sender } = req.body;

  db.run(
    "INSERT INTO friends (user1, user2) VALUES (?, ?)",
    [sender, user]
  );

  db.run(
    "DELETE FROM friend_requests WHERE sender=? AND receiver=?",
    [sender, user]
  );

  res.json({ ok: true });
});

app.get("/friends", (req, res) => {
  const user = req.session.user;

  db.all(
    `
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
    `,
    [user, user, user, user],
    (err, rows) => {
      if (err) {
        console.error(err);
        return res.sendStatus(500);
      }

      res.json(rows);
    }
  );
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

  db.run(
    "UPDATE users SET avatar = ? WHERE username = ?",
    [filePath, user],
    (err) => {
      if (err) {
        console.error("DB error:", err);
        return res.status(500).json({ error: "Database failed" });
      }

      res.json({
        ok: true,
        avatar: filePath
      });
    }
  );
});

/* ===== MESSAGES ===== */

app.get("/messages", (req, res) => {
  const user = req.session.user;
  const withUser = req.query.withUser;

  db.all(
    `SELECT messages.*, users.avatar 
    FROM messages 
    JOIN users ON users.username = messages.sender
    WHERE (sender=? AND receiver=?) 
    OR (sender=? AND receiver=?)`,
    [user, withUser, withUser, user],
    (err, rows) => res.json(rows)
  );
});

/* ===== SOCKET ===== */

io.on("connection", (socket) => {
  socket.on("sendMessage", (msg) => {
    db.run(
      "INSERT INTO messages (sender, receiver, text, timestamp) VALUES (?, ?, ?, ?)",
      [msg.sender, msg.to, msg.text, Date.now()]
    );

    db.get(
      "SELECT avatar FROM users WHERE username = ?",
      [msg.sender],
      (err, row) => {
        if (err) {
          console.error("DB error:", err);
          return;
        }

        io.emit("newMessage", {
          avatar: row ? row.avatar : `https://api.dicebear.com/7.x/initials/svg?seed=${msg.sender}`,
          sender: msg.sender,
          receiver: msg.to,
          text: msg.text,
          timestamp: Date.now()
        });
      });
    }
  );
});

server.listen(3000, () => console.log("running on 3000"));