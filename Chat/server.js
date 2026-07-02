const express = require("express");
const http = require("http");
const multer = require("multer");
const { Server } = require("socket.io");
const session = require("express-session");
const { Pool } = require("pg");

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

/* ===== HELPER ===== */

function bufferToImage(buffer) {
  if (!buffer) return null;
  return `data:image/png;base64,${buffer.toString("base64")}`;
}

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
    "SELECT username, avatar FROM users WHERE username = $1",
    [user]
  );

  const u = rows[0];
  if (u && u.avatar) u.avatar = bufferToImage(u.avatar);

  res.json({ user: u });
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

app.get("/debug/db", async (req, res) => {
  try {
    const tables = ["users", "messages", "friends", "friend_requests"];
    const result = {};

    for (const table of tables) {
      const { rows } = await pool.query(`SELECT * FROM ${table}`);
      result[table] = rows;
    }

    res.json(result);
  } catch (err) {
    console.error(err);
    res.send("error");
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

app.get("/avatar/:username", async (req, res) => {
  const { username } = req.params;

  try {
    const { rows } = await pool.query(
      "SELECT avatar FROM users WHERE username = $1",
      [username]
    );

    if (!rows.length || !rows[0].avatar) {
      return res.sendStatus(404);
    }

    const avatar = rows[0].avatar;

    if (Buffer.isBuffer(avatar)) {
      res.set("Content-Type", "image/png");
      return res.send(avatar);
    }
    
    if (typeof avatar === "string") {
      return res.redirect(avatar);
    }

    res.sendStatus(404);
  } catch (err) {
    console.error(err);
    res.sendStatus(500);
  }
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
        END AS username,

        CASE 
          WHEN f.user1 = $1 THEN u2.avatar 
          ELSE u1.avatar 
        END AS avatar

      FROM friends f
      JOIN users u1 ON f.user1 = u1.username
      JOIN users u2 ON f.user2 = u2.username

      WHERE f.user1 = $1 OR f.user2 = $1
    `, [user]);

    const fixed = rows.map(r => ({
      ...r,
      avatar: bufferToImage(r.avatar)
    }));

    res.json(fixed);
  } catch (err) {
    console.error(err);
    res.sendStatus(500);
  }
});

/* ===== UPLOAD ===== */

const upload = multer({ storage: multer.memoryStorage() });

app.post("/set-avatar", upload.single("avatar"), async (req, res) => {
  const user = req.session.user;

  if (!user) return res.status(401).json({ error: "Not logged in" });
  if (!req.file) return res.status(400).json({ error: "No file uploaded" });

  await pool.query(
    "UPDATE users SET avatar = $1 WHERE username = $2",
    [req.file.buffer, user]
  );

  res.json({ ok: true });
});

/* ===== MESSAGES ===== */

app.get("/messages", async (req, res) => {
  const user = req.session.user;
  const withUser = req.query.withUser;

  const { rows } = await pool.query(`
    SELECT messages.*, users.avatar 
    FROM messages 
    JOIN users ON users.username = messages.sender
    WHERE (sender=$1 AND receiver=$2) 
       OR (sender=$2 AND receiver=$1)
  `, [user, withUser]);

  const fixed = rows.map(r => ({
    ...r,
    avatar: bufferToImage(r.avatar)
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

    const { rows } = await pool.query(
      "SELECT avatar FROM users WHERE username = $1",
      [msg.sender]
    );

    io.emit("newMessage", {
      avatar: bufferToImage(rows[0]?.avatar) || `https://api.dicebear.com/7.x/initials/svg?seed=${msg.sender}`,
      sender: msg.sender,
      receiver: msg.to,
      text: msg.text,
      timestamp: Date.now()
    });
  });
});

server.listen(3000, () => console.log("running on 3000"));
