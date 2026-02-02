import express from "express";
import cors from "cors";
import dotenv from "dotenv";
import path from "path";
import fs from "fs";
import { fileURLToPath } from "url";
import bcrypt from "bcryptjs";
import multer from "multer";
import { Server } from "socket.io";
import http from "http";

import { initDb, all, get, run } from "./db.js";
import { authMiddleware, signToken, socketAuth } from "./auth.js";

dotenv.config();
initDb();

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const PORT = Number(process.env.PORT || 4000);
const CORS_ORIGIN = process.env.CORS_ORIGIN || "http://localhost:5173";

const app = express();
app.use(cors({ origin: CORS_ORIGIN, credentials: true }));
app.use(express.json({ limit: "10mb" }));

// uploads
const uploadsDir = path.join(__dirname, "uploads");
if (!fs.existsSync(uploadsDir)) fs.mkdirSync(uploadsDir, { recursive: true });
app.use("/uploads", express.static(uploadsDir));

const storage = multer.diskStorage({
  destination: (_req, _file, cb) => cb(null, uploadsDir),
  filename: (_req, file, cb) => {
    const safe = file.originalname.replace(/[^a-zA-Z0-9._-]/g, "_");
    cb(null, `${Date.now()}_${safe}`);
  },
});
const upload = multer({ storage });

// ---------------- AUTH ----------------
app.post("/api/auth/register", async (req, res) => {
  try {
    const { username, email, password, about = "" } = req.body || {};
    if (!username || !email || !password) return res.status(400).json({ error: "Missing fields" });
    const existing = await get("SELECT id FROM users WHERE username=? OR email=?", [username, email]);
    if (existing) return res.status(409).json({ error: "User exists" });

    const hash = bcrypt.hashSync(password, 10);
    const createdAt = Date.now();
    const r = await run(
      "INSERT INTO users (username, email, password_hash, about, created_at) VALUES (?, ?, ?, ?, ?)",
      [username, email, hash, about, createdAt]
    );
    const user = await get("SELECT id, username, email, about, avatar_url FROM users WHERE id=?", [r.lastID]);
    const token = signToken(user);
    res.json({ token, user });
  } catch (e) {
    res.status(500).json({ error: "Register failed", details: String(e) });
  }
});

app.post("/api/auth/login", async (req, res) => {
  try {
    const { email, password } = req.body || {};
    if (!email || !password) return res.status(400).json({ error: "Missing fields" });
    const user = await get("SELECT * FROM users WHERE email=?", [email]);
    if (!user) return res.status(401).json({ error: "Bad credentials" });
    const ok = bcrypt.compareSync(password, user.password_hash);
    if (!ok) return res.status(401).json({ error: "Bad credentials" });

    const token = signToken(user);
    res.json({
      token,
      user: { id: user.id, username: user.username, email: user.email, about: user.about, avatar_url: user.avatar_url },
    });
  } catch (e) {
    res.status(500).json({ error: "Login failed", details: String(e) });
  }
});

app.get("/api/me", authMiddleware, async (req, res) => {
  const user = await get("SELECT id, username, email, about, avatar_url FROM users WHERE id=?", [req.userId]);
  res.json({ user });
});

app.get("/api/users/search", authMiddleware, async (req, res) => {
  const q = String(req.query.q || "").trim();
  if (!q) return res.json({ users: [] });
  const users = await all(
    "SELECT id, username, about, avatar_url FROM users WHERE username LIKE ? AND id != ? LIMIT 25",
    [`%${q}%`, req.userId]
  );
  res.json({ users });
});

// ---------------- PROFILE ----------------
app.post("/api/profile", authMiddleware, async (req, res) => {
  try {
    const { username, about } = req.body || {};
    if (!username) return res.status(400).json({ error: "username required" });
    await run("UPDATE users SET username=?, about=? WHERE id=?", [username, about || "", req.userId]);
    const user = await get("SELECT id, username, email, about, avatar_url FROM users WHERE id=?", [req.userId]);
    res.json({ user });
  } catch (e) {
    res.status(500).json({ error: "Profile update failed", details: String(e) });
  }
});

app.post("/api/profile/avatar", authMiddleware, upload.single("file"), async (req, res) => {
  const url = `/uploads/${req.file.filename}`;
  await run("UPDATE users SET avatar_url=? WHERE id=?", [url, req.userId]);
  const user = await get("SELECT id, username, email, about, avatar_url FROM users WHERE id=?", [req.userId]);
  res.json({ user });
});

// ---------------- CHATS ----------------
async function ensureDmChat(userA, userB) {
  // find existing dm chat with exactly these two members
  const rows = await all(
    `
    SELECT c.id as chat_id
    FROM chats c
    JOIN chat_members m1 ON m1.chat_id=c.id AND m1.user_id=?
    JOIN chat_members m2 ON m2.chat_id=c.id AND m2.user_id=?
    WHERE c.type='dm'
    LIMIT 1
    `,
    [userA, userB]
  );
  if (rows?.length) return rows[0].chat_id;

  const createdAt = Date.now();
  const r = await run("INSERT INTO chats (type, title, created_at) VALUES ('dm', '', ?)", [createdAt]);
  const chatId = r.lastID;
  await run("INSERT INTO chat_members (chat_id, user_id) VALUES (?,?)", [chatId, userA]);
  await run("INSERT INTO chat_members (chat_id, user_id) VALUES (?,?)", [chatId, userB]);
  return chatId;
}

app.post("/api/chats/dm", authMiddleware, async (req, res) => {
  const { username } = req.body || {};
  if (!username) return res.status(400).json({ error: "username required" });
  const other = await get("SELECT id, username, avatar_url, about FROM users WHERE username=?", [username]);
  if (!other) return res.status(404).json({ error: "User not found" });
  if (other.id === req.userId) return res.status(400).json({ error: "Cannot DM yourself" });

  const chatId = await ensureDmChat(req.userId, other.id);
  res.json({ chat: { id: chatId, type: "dm", title: other.username, peer: other } });
});



// ---------------- GROUPS & CHANNELS ----------------
function okSlug(slug) {
  return /^[a-z0-9_-]{3,32}$/i.test(slug);
}

async function getChat(chatId) {
  return await get("SELECT id, type, title, slug, is_public, owner_user_id FROM chats WHERE id=?", [chatId]);
}

async function getRole(chatId, userId) {
  const row = await get("SELECT role, status FROM chat_members WHERE chat_id=? AND user_id=?", [chatId, userId]);
  if (!row || row.status !== 'active') return null;
  return row.role || 'member';
}

async function canReadChat(chatId, userId) {
  const role = await getRole(chatId, userId);
  if (role) return true;
  const c = await getChat(chatId);
  return c && c.type === 'channel' && Number(c.is_public) === 1;
}

app.post("/api/groups", authMiddleware, async (req, res) => {
  try {
    const { title, memberIds = [] } = req.body || {};
    const cleanTitle = String(title || "").trim();
    if (!cleanTitle) return res.status(400).json({ error: "title required" });

    const createdAt = Date.now();
    const r = await run(
      "INSERT INTO chats (type, title, owner_user_id, created_at) VALUES ('group', ?, ?, ?)",
      [cleanTitle, req.userId, createdAt]
    );
    const chatId = r.lastID;
    const joinedAt = Date.now();
    await run("INSERT OR REPLACE INTO chat_members (chat_id, user_id, role, status, joined_at) VALUES (?,?,?,?,?)", [chatId, req.userId, 'owner', 'active', joinedAt]);

    // add members (ignore duplicates)
    for (const uid of memberIds) {
      const id = Number(uid);
      if (!id || id === req.userId) continue;
      await run("INSERT OR IGNORE INTO chat_members (chat_id, user_id, role, status, joined_at) VALUES (?,?,?,?,?)", [chatId, id, 'member', 'active', joinedAt]);
    }

    const chat = await getChat(chatId);
    res.json({ chat });
  } catch (e) {
    res.status(500).json({ error: "Create group failed", details: String(e) });
  }
});

app.post("/api/groups/:chatId/invite", authMiddleware, async (req, res) => {
  try {
    const chatId = Number(req.params.chatId);
    const { userId } = req.body || {};
    const uid = Number(userId);
    if (!chatId || !uid) return res.status(400).json({ error: "Bad request" });

    const c = await getChat(chatId);
    if (!c || c.type !== 'group') return res.status(404).json({ error: "Group not found" });

    const role = await getRole(chatId, req.userId);
    if (!role || (role !== 'owner' && role !== 'admin')) return res.status(403).json({ error: "Not allowed" });

    const joinedAt = Date.now();
    await run("INSERT OR REPLACE INTO chat_members (chat_id, user_id, role, status, joined_at) VALUES (?,?,?,?,?)", [chatId, uid, 'member', 'active', joinedAt]);
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: "Invite failed", details: String(e) });
  }
});

app.post("/api/groups/:chatId/leave", authMiddleware, async (req, res) => {
  try {
    const chatId = Number(req.params.chatId);
    const c = await getChat(chatId);
    if (!c || c.type !== 'group') return res.status(404).json({ error: "Group not found" });

    await run("UPDATE chat_members SET status='left' WHERE chat_id=? AND user_id=?", [chatId, req.userId]);
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: "Leave failed", details: String(e) });
  }
});

app.post("/api/channels", authMiddleware, async (req, res) => {
  try {
    const { title, slug, isPublic = true } = req.body || {};
    const cleanTitle = String(title || "").trim();
    const cleanSlug = String(slug || "").trim();
    if (!cleanTitle) return res.status(400).json({ error: "title required" });
    if (!okSlug(cleanSlug)) return res.status(400).json({ error: "Bad slug (3-32 chars: a-z0-9_- )" });

    const existing = await get("SELECT id FROM chats WHERE slug=?", [cleanSlug]);
    if (existing) return res.status(409).json({ error: "Slug already used" });

    const createdAt = Date.now();
    const r = await run(
      "INSERT INTO chats (type, title, slug, is_public, owner_user_id, created_at) VALUES ('channel', ?, ?, ?, ?, ?)",
      [cleanTitle, cleanSlug, isPublic ? 1 : 0, req.userId, createdAt]
    );
    const chatId = r.lastID;
    const joinedAt = Date.now();
    await run("INSERT OR REPLACE INTO chat_members (chat_id, user_id, role, status, joined_at) VALUES (?,?,?,?,?)", [chatId, req.userId, 'owner', 'active', joinedAt]);

    const chat = await getChat(chatId);
    res.json({ chat });
  } catch (e) {
    res.status(500).json({ error: "Create channel failed", details: String(e) });
  }
});

app.get("/api/channels", authMiddleware, async (req, res) => {
  const q = String(req.query.q || "").trim();
  const like = `%${q.replace(/%/g, "")}%`;
  const rows = await all(
    `
    SELECT c.id, c.title, c.slug, c.is_public,
           (SELECT COUNT(*) FROM chat_members cm WHERE cm.chat_id=c.id AND cm.status='active') as members,
           (SELECT 1 FROM chat_members cm2 WHERE cm2.chat_id=c.id AND cm2.user_id=? AND cm2.status='active') as subscribed
    FROM chats c
    WHERE c.type='channel' AND c.is_public=1 AND (c.title LIKE ? OR c.slug LIKE ?)
    ORDER BY c.id DESC
    LIMIT 100
    `,
    [req.userId, like, like]
  );
  res.json({ channels: rows.map(r => ({...r, subscribed: !!r.subscribed})) });
});

app.post("/api/channels/:chatId/subscribe", authMiddleware, async (req, res) => {
  try {
    const chatId = Number(req.params.chatId);
    const c = await getChat(chatId);
    if (!c || c.type !== 'channel') return res.status(404).json({ error: "Channel not found" });
    if (Number(c.is_public) !== 1) return res.status(403).json({ error: "Channel is private" });

    const joinedAt = Date.now();
    await run("INSERT OR REPLACE INTO chat_members (chat_id, user_id, role, status, joined_at) VALUES (?,?,?,?,?)", [chatId, req.userId, 'member', 'active', joinedAt]);
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: "Subscribe failed", details: String(e) });
  }
});

app.post("/api/channels/:chatId/unsubscribe", authMiddleware, async (req, res) => {
  try {
    const chatId = Number(req.params.chatId);
    const c = await getChat(chatId);
    if (!c || c.type !== 'channel') return res.status(404).json({ error: "Channel not found" });

    await run("UPDATE chat_members SET status='left' WHERE chat_id=? AND user_id=?", [chatId, req.userId]);
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: "Unsubscribe failed", details: String(e) });
  }
});
app.get("/api/chats", authMiddleware, async (req, res) => {
  const chats = await all(
    `
    SELECT c.id, c.type, c.title, c.slug, c.is_public, c.created_at
    FROM chats c
    JOIN chat_members m ON m.chat_id=c.id
    WHERE m.user_id=? AND m.status='active'
    ORDER BY c.id DESC
    `,
    [req.userId]
  );

  // map DM title to peer username
  const out = [];
  for (const c of chats) {
    if (c.type === "dm") {
      const peer = await get(
        `
        SELECT u.id, u.username, u.avatar_url, u.about
        FROM chat_members m
        JOIN users u ON u.id=m.user_id
        WHERE m.chat_id=? AND u.id != ?
        LIMIT 1
        `,
        [c.id, req.userId]
      );
      const last = await get(
        "SELECT kind, text, file_name, created_at FROM messages WHERE chat_id=? ORDER BY id DESC LIMIT 1",
        [c.id]
      );
      const subtitle =
        !last ? "" :
        last.kind === "text" ? (last.text || "") :
        last.kind === "image" ? "Photo" :
        last.kind === "voice" ? "Voice" :
        last.kind === "file" ? (last.file_name || "File") : "";

      out.push({ id: c.id, type: c.type, title: peer?.username || "DM", peer, subtitle });
    } else {
      const last = await get(
        "SELECT kind, text, file_name, created_at FROM messages WHERE chat_id=? ORDER BY id DESC LIMIT 1",
        [c.id]
      );
      const subtitle =
        !last ? "" :
        last.kind === "text" ? (last.text || "") :
        last.kind === "image" ? "Photo" :
        last.kind === "voice" ? "Voice" :
        last.kind === "file" ? (last.file_name || "File") : "";

      const title =
        c.type === "channel" ? `#${c.slug || c.title || 'channel'}` : (c.title || "Group");

      out.push({ id: c.id, type: c.type, title, slug: c.slug || "", is_public: !!c.is_public, peer: null, subtitle });
    }
  }

  res.json({ chats: out });
});

app.delete("/api/chats/:chatId", authMiddleware, async (req, res) => {
  const chatId = Number(req.params.chatId);
  if (!chatId) return res.status(400).json({ error: "Bad chatId" });

  // allow deletion if member
  const member = await get("SELECT 1 FROM chat_members WHERE chat_id=? AND user_id=? AND status='active'", [chatId, req.userId]);
  if (!member) return res.status(403).json({ error: "Not a member" });

  await run("DELETE FROM chats WHERE id=?", [chatId]);
  res.json({ ok: true });
});

// ---------------- MESSAGES ----------------
app.get("/api/messages/:chatId", authMiddleware, async (req, res) => {
  const chatId = Number(req.params.chatId);
  const ok = await canReadChat(chatId, req.userId);
  if (!ok) return res.status(403).json({ error: "Not allowed" });

  const rows = await all(
    `
    SELECT m.id, m.kind, m.text, m.file_url, m.file_name, m.file_size, m.mime, m.duration_sec, m.created_at,
           u.username as sender_username, u.id as sender_id
    FROM messages m
    JOIN users u ON u.id=m.sender_id
    WHERE m.chat_id=?
    ORDER BY m.id ASC
    LIMIT 500
    `,
    [chatId]
  );

  res.json({ messages: rows });
});

// upload for chat content
app.post("/api/upload", authMiddleware, upload.single("file"), async (req, res) => {
  const url = `/uploads/${req.file.filename}`;
  res.json({ url, name: req.file.originalname, size: req.file.size, mime: req.file.mimetype });
});

// ---------------- Socket.IO realtime + signaling ----------------
const server = http.createServer(app);
const io = new Server(server, {
  cors: { origin: CORS_ORIGIN, credentials: true },
});

io.use(socketAuth);

io.on("connection", async (socket) => {
  const userId = socket.userId;
  socket.join(`user:${userId}`);

  // join all chat rooms
  const myChats = await all("SELECT chat_id FROM chat_members WHERE user_id=? AND status='active'", [userId]);
  myChats.forEach((c) => socket.join(`chat:${c.chat_id}`));

  socket.on("join_chat", async ({ chatId }) => {
    const member = await get("SELECT 1 FROM chat_members WHERE chat_id=? AND user_id=? AND status='active'", [chatId, userId]);
    if (member) socket.join(`chat:${chatId}`);
  });

  socket.on("send_message", async (payload, ack) => {
    try {
      const { chatId, kind, text = "", fileUrl = "", fileName = "", fileSize = 0, mime = "", durationSec = 0 } = payload || {};
      const member = await get("SELECT 1 FROM chat_members WHERE chat_id=? AND user_id=? AND status='active'", [chatId, userId]);
      if (!member) return ack?.({ ok: false, error: "Not a member" });

      const createdAt = Date.now();
      const r = await run(
        `INSERT INTO messages (chat_id, sender_id, kind, text, file_url, file_name, file_size, mime, duration_sec, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [chatId, userId, kind, text, fileUrl, fileName, fileSize, mime, durationSec, createdAt]
      );

      const sender = await get("SELECT id, username, avatar_url FROM users WHERE id=?", [userId]);

      const msg = {
        id: r.lastID,
        chat_id: chatId,
        sender_id: userId,
        sender_username: sender.username,
        kind,
        text,
        file_url: fileUrl,
        file_name: fileName,
        file_size: fileSize,
        mime,
        duration_sec: durationSec,
        created_at: createdAt,
      };

      io.to(`chat:${chatId}`).emit("message", msg);
      ack?.({ ok: true, message: msg });
    } catch (e) {
      ack?.({ ok: false, error: String(e) });
    }
  });

  // basic signaling for calls (WebRTC)
  socket.on("call_offer", ({ chatId, offer }) => {
    socket.to(`chat:${chatId}`).emit("call_offer", { fromUserId: userId, offer, chatId });
  });
  socket.on("call_answer", ({ chatId, answer }) => {
    socket.to(`chat:${chatId}`).emit("call_answer", { fromUserId: userId, answer, chatId });
  });
  socket.on("ice_candidate", ({ chatId, candidate }) => {
    socket.to(`chat:${chatId}`).emit("ice_candidate", { fromUserId: userId, candidate, chatId });
  });

  socket.on("disconnect", () => {});
});

server.listen(PORT, () => {
  console.log(`[Sizero server] http://localhost:${PORT}`);
});
