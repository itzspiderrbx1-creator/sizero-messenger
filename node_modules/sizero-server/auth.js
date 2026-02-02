import jwt from "jsonwebtoken";

export function signToken(user) {
  const secret = process.env.JWT_SECRET || "dev_secret";
  return jwt.sign({ uid: user.id }, secret, { expiresIn: "7d" });
}

export function authMiddleware(req, res, next) {
  const header = req.headers.authorization || "";
  const token = header.startsWith("Bearer ") ? header.slice(7) : null;
  if (!token) return res.status(401).json({ error: "No token" });

  try {
    const secret = process.env.JWT_SECRET || "dev_secret";
    const payload = jwt.verify(token, secret);
    req.userId = payload.uid;
    next();
  } catch {
    res.status(401).json({ error: "Invalid token" });
  }
}

export function socketAuth(socket, next) {
  const token = socket.handshake.auth?.token;
  if (!token) return next(new Error("No token"));
  try {
    const secret = process.env.JWT_SECRET || "dev_secret";
    const payload = jwt.verify(token, secret);
    socket.userId = payload.uid;
    next();
  } catch {
    next(new Error("Invalid token"));
  }
}
