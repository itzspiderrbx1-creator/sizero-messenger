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

// ---------- APP ----------
const app = express();

// CORS (работает с credentials + Render)
const allowlist = CORS_ORIGIN.split(",").map(s => s.trim()).filter(Boolean);
app.use(
  cors({
    origin: (origin, cb) => {
      if (!origin) return cb(null, true);
      if (allowlist.includes("*")) return cb(null, true);
      return cb(null, allowlist.includes(origin));
    },
    credentials: true,
  })
);

app.use(express.json({ limit: "10mb" }));

// ---------- UPLOADS ----------
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

// ---------- AUTH ----------
app.post("/api/auth/register", async (req, res) => {
  try {
    const { username, email, password, about = "" } = req.body || {};
    if (!username || !email || !password) return res.status(400).json({ error: "Missing fields" });

    const existing = await get(
      "SELECT id FROM users WHERE username=? OR email=?",
      [username, email]
    );
    if (existing) return res.status(409).json({ error: "User exists" });

    const hash = bcrypt.hashSync(password, 10);
    const createdAt = Date.now();

    const r = await run(
      "INSERT INTO users (username, email, password_hash, about, created_at) VALUES (?, ?, ?, ?, ?)",
      [username, email, hash, about, createdAt]
    );

    const user = await get(
      "SELECT id, username, email, about, avatar_url FROM users WHERE id=?",
      [r.lastID]
    );

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
      user: {
        id: user.id,
        username: user.username,
        email: user.email,
        about: user.about,
        avatar_url: user.avatar_url,
      },
    });
  } catch (e) {
    res.status(500).json({ error: "Login failed", details: String(e) });
  }
});

app.get("/api/me", authMiddleware, async (req, res) => {
  const user = await get(
    "SELECT id, username, email, about, avatar_url FROM users WHERE id=?",
    [req.userId]
  );
  res.json({ user });
});

// ---------------- SERVE FRONTEND (production) ----------------
if (process.env.NODE_ENV === "production") {
  const distPath = path.join(__dirname, "../client/dist");

  // маленький дебаг в логах Render
  console.log("[frontend] distPath =", distPath, "exists =", fs.existsSync(distPath));

  app.use(express.static(distPath));

  // SPA fallback: отдаём index.html на все НЕ-API запросы
  app.get("*", (req, res, next) => {
    if (req.path.startsWith("/api") || req.path.startsWith("/uploads") || req.path.startsWith("/socket.io")) {
      return next();
    }
    return res.sendFile(path.join(distPath, "index.html"));
  });
}

// ---------- SOCKET.IO ----------
const server = http.createServer(app);

const io = new Server(server, {
  cors: { origin: CORS_ORIGIN, credentials: true },
});

io.use(socketAuth);

io.on("connection", async (socket) => {
  const userId = socket.userId;
  socket.join(`user:${userId}`);

  const myChats = await all(
    "SELECT chat_id FROM chat_members WHERE user_id=? AND status='active'",
    [userId]
  );
  myChats.forEach((c) => socket.join(`chat:${c.chat_id}`));

  socket.on("send_message", async (payload, ack) => {
    try {
      const { chatId, kind, text = "" } = payload || {};
      const createdAt = Date.now();

      const r = await run(
        "INSERT INTO messages (chat_id, sender_id, kind, text, created_at) VALUES (?,?,?,?,?)",
        [chatId, userId, kind, text, createdAt]
      );

      const msg = {
        id: r.lastID,
        chat_id: chatId,
        sender_id: userId,
        kind,
        text,
        created_at: createdAt,
      };

      io.to(`chat:${chatId}`).emit("message", msg);
      ack?.({ ok: true, message: msg });
    } catch (e) {
      ack?.({ ok: false, error: String(e) });
    }
  });
});

// ---------- START ----------
server.listen(PORT, () => {
  console.log(`[Sizero] Server running on port ${PORT}`);
});
