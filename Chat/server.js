const express = require("express");
const http = require("http");
const multer = require("multer");
const { Server } = require("socket.io");
const session = require("express-session");
const { Pool } = require("pg");
const sharp = require("sharp");

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
});

const app = express();
const server = http.createServer(app);
const io = new Server(server);

app.use(express.json());
app.use(express.static("public"));
app.use("/uploads", express.static("uploads"));

app.set("trust proxy", 1);

app.use(session({
  secret: process.env.SESSION_SECRET,
  resave: false,
  saveUninitialized: false,
  cookie: {
    secure: true,
    sameSite: "none"
  }
}));

/* ===== DB SETUP ===== */

(async () => {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS users (
      id SERIAL PRIMARY KEY,
      username TEXT UNIQUE,
      password TEXT,
      avatar BYTEA
    )
  `);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS messages (
      id SERIAL PRIMARY KEY,
      sender TEXT,
      receiver TEXT,
      text TEXT,
      timestamp BIGINT
    )
  `);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS friends (
      id SERIAL PRIMARY KEY,
      user1 TEXT,
      user2 TEXT
    )
  `);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS friend_requests (
      id SERIAL PRIMARY KEY,
      sender TEXT,
      receiver TEXT
    )
  `);
})();

/* ===== AUTH ===== */

app.get("/me", async (req, res) => {
  const user = req.session.user;
  if (!user) return res.json({ user: null });

  const { rows } = await pool.query(
    "SELECT username FROM users WHERE username = $1",
    [user]
  );

  if (!rows.length) return res.json({ user: null });

  res.json({
    user: {
      username: rows[0].username,
      avatar: `/avatar/${rows[0].username}`
    }
  });
});

app.post("/register", async (req, res) => {
  const { username, password } = req.body;

  await pool.query(
    "INSERT INTO users (username, password, avatar) VALUES ($1, $2, $3)",
    [username, password, null]
  );

  res.json({ ok: true });
});

app.post("/login", async (req, res) => {
  const { username, password } = req.body;

  const { rows } = await pool.query(
    "SELECT * FROM users WHERE username=$1 AND password=$2",
    [username, password]
  );

  if (rows.length) {
    req.session.user = username;
    res.json({ ok: true });
  } else {
    res.json({ ok: false });
  }
});

app.post("/logout", (req, res) => {
  req.session.destroy(() => res.json({ ok: true }));
});

/* ===== AVATAR ROUTE (SINGLE SOURCE OF TRUTH) ===== */

app.get("/avatar/:username", async (req, res) => {
  const { username } = req.params;

  try {
    const { rows } = await pool.query(
      "SELECT avatar FROM users WHERE username = $1",
      [username]
    );

    if (!rows.length || !rows[0].avatar) {
      return res.redirect(`https://api.dicebear.com/7.x/initials/svg?seed=${username}`);
    }

    const avatar = rows[0].avatar;

    // DB image
    if (typeof avatar !== "string") {
      res.set("Content-Type", "image/webp");
      return res.send(avatar);
    }

    // old uploads path
    if (avatar.startsWith("/uploads/")) {
      return res.redirect(avatar);
    }

    // external URL (dicebear etc)
    return res.redirect(avatar);

  } catch (err) {
    console.error(err);
    res.sendStatus(500);
  }
});

/* ===== FRIEND SYSTEM ===== */

app.post("/add-friend", async (req, res) => {
  const sender = req.session.user;
  const { receiver } = req.body;

  if (!sender) return res.sendStatus(401);

  await pool.query(
    "INSERT INTO friend_requests (sender, receiver) VALUES ($1, $2)",
    [sender, receiver]
  );

  res.json({ ok: true });
});

app.get("/pending", async (req, res) => {
  const user = req.session.user;

  const { rows } = await pool.query(
    "SELECT sender FROM friend_requests WHERE receiver = $1",
    [user]
  );

  res.json(rows.map(r => r.sender));
});

app.get("/friend-requests", async (req, res) => {
  const user = req.session.user;

  const { rows } = await pool.query(
    "SELECT * FROM friend_requests WHERE receiver=$1",
    [user]
  );

  res.json(rows);
});

app.post("/accept-friend", async (req, res) => {
  const user = req.session.user;
  const { sender } = req.body;

  await pool.query(
    "INSERT INTO friends (user1, user2) VALUES ($1, $2)",
    [sender, user]
  );

  await pool.query(
    "DELETE FROM friend_requests WHERE sender=$1 AND receiver=$2",
    [sender, user]
  );

  res.json({ ok: true });
});

app.get("/friends", async (req, res) => {
  const user = req.session.user;

  try {
    const { rows } = await pool.query(`
      SELECT 
        CASE 
          WHEN f.user1 = $1 THEN u2.username 
          ELSE u1.username 
        END AS username
      FROM friends f
      JOIN users u1 ON f.user1 = u1.username
      JOIN users u2 ON f.user2 = u2.username
      WHERE f.user1 = $1 OR f.user2 = $1
    `, [user]);

    const fixed = rows.map(r => ({
      username: r.username,
      avatar: `/avatar/${r.username}`
    }));

    res.json(fixed);
  } catch (err) {
    console.error(err);
    res.sendStatus(500);
  }
});

/* ===== UPLOAD ===== */

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 2 * 1024 * 1024 }
});

app.post("/set-avatar", upload.single("avatar"), async (req, res) => {
  try {
    const user = req.session.user;

    if (!user) return res.status(401).json({ error: "Not logged in" });
    if (!req.file) return res.status(400).json({ error: "No file uploaded" });

    const compressed = await sharp(req.file.buffer)
      .resize(128, 128, { fit: "cover" })
      .webp({ quality: 60 })
      .toBuffer();

    await pool.query(
      "UPDATE users SET avatar = $1 WHERE username = $2",
      [compressed, user]
    );

    res.json({ ok: true });

  } catch (err) {
    console.error("UPLOAD ERROR:", err);
    res.status(500).json({ error: "Upload failed" });
  }
});

/* ===== MESSAGES ===== */

app.get("/messages", async (req, res) => {
  const user = req.session.user;
  const withUser = req.query.withUser;
  const WEEK = 7 * 24 * 60 * 60 * 1000;

  const { rows } = await pool.query(`
    SELECT messages.*, users.username as senderName
    FROM messages 
    JOIN users ON users.username = messages.sender
    WHERE ( (sender=$1 AND receiver=$2) 
       OR (sender=$2 AND receiver=$1) )
    AND messages.timestamp > $3
  `, [user, withUser, Date.now() - WEEK]);

  const fixed = rows.map(r => ({
    ...r,
    avatar: `/avatar/${r.sender}`
  }));

  res.json(fixed);
});

/* ===== SOCKET ===== */

io.on("connection", (socket) => {
  socket.on("sendMessage", async (msg) => {

    await pool.query(
      "INSERT INTO messages (sender, receiver, text, timestamp) VALUES ($1, $2, $3, $4)",
      [msg.sender, msg.to, msg.text, Date.now()]
    );
    
    const WEEK = 7 * 24 * 60 * 60 * 1000;

    await pool.query(
      "DELETE FROM messages WHERE timestamp < $1",
      [Date.now() - WEEK]
    );

    io.emit("newMessage", {
      avatar: `/avatar/${msg.sender}`,
      sender: msg.sender,
      receiver: msg.to,
      text: msg.text,
      timestamp: Date.now()
    });
  });
});

server.listen(3000, () => console.log("running on 3000"));
