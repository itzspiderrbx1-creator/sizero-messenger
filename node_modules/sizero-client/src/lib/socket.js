import { io } from "socket.io-client";

export function makeSocket(token) {
  return io("http://localhost:4000", {
    autoConnect: false,
    auth: { token }
  });
}
