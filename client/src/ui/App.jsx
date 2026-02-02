import React, { useEffect, useMemo, useRef, useState } from "react";
import { AnimatePresence, motion } from "framer-motion";
import { Camera, Check, ChevronDown, ChevronLeft, LogOut, Mic, Paperclip, Phone, Search, Settings, Send, Trash2, Video, X } from "lucide-react";
import { api, uploadAvatar, uploadFile } from "../lib/api.js";
import { makeSocket } from "../lib/socket.js";

const cx = (...c) => c.filter(Boolean).join(" ");
const mmss = (sec) => {
  const s = Math.max(0, Math.floor(sec || 0));
  const m = String(Math.floor(s / 60)).padStart(2, "0");
  const ss = String(s % 60).padStart(2, "0");
  return `${m}:${ss}`;
};
const initials = (name) => {
  const p = String(name || "").trim().split(/\s+/).filter(Boolean).slice(0, 2);
  if (!p.length) return "S";
  return p.map((x) => x[0]?.toUpperCase()).join("").slice(0, 2);
};

export default function App() {
  const [route, setRoute] = useState("auth"); // auth | app
  const [authMode, setAuthMode] = useState("register");

  const [token, setToken] = useState(localStorage.getItem("sizero_token") || "");
  const [me, setMe] = useState(null);

  const [chats, setChats] = useState([]);
  const [activeChat, setActiveChat] = useState(null);
  const [messages, setMessages] = useState([]);

  const [uiModal, setUiModal] = useState(null); // null | "group" | "channel" | "catalog"
  const [groupTitle, setGroupTitle] = useState("");
  const [groupQuery, setGroupQuery] = useState("");
  const [groupResults, setGroupResults] = useState([]);
  const [groupSelected, setGroupSelected] = useState({}); // {id:true}
  const [channelTitle, setChannelTitle] = useState("");
  const [channelSlug, setChannelSlug] = useState("");
  const [catalogQuery, setCatalogQuery] = useState("");
  const [catalogChannels, setCatalogChannels] = useState([]);

  const [profileOpen, setProfileOpen] = useState(false);
  const [incoming, setIncoming] = useState(null); // {chatId, fromUserId}
  const [call, setCall] = useState(null); // {chatId, peerName, role:"caller"|"callee"}
  const pcRef = useRef(null);
  const localStreamRef = useRef(null);
  const remoteStreamRef = useRef(null);
  const [localReady, setLocalReady] = useState(false);
  const [remoteReady, setRemoteReady] = useState(false);

  const socketRef = useRef(null);

  const [isMobile, setIsMobile] = useState(false);

  useEffect(() => {
    const mq = window.matchMedia("(max-width: 768px)");
    const apply = () => setIsMobile(Boolean(mq.matches));
    apply();
    mq.addEventListener?.("change", apply);
    return () => mq.removeEventListener?.("change", apply);
  }, []);

  // background glows
  const Bg = (
    <>
      <div className="pointer-events-none absolute -left-40 top-10 h-[520px] w-[520px] rounded-full bg-orange-500/25 blur-[90px]" />
      <div className="pointer-events-none absolute -right-32 bottom-[-120px] h-[560px] w-[560px] rounded-full bg-sky-500/25 blur-[100px]" />
    </>
  );

  async function loadMeAndChats(t) {
    const meRes = await api("/api/me", { token: t });
    setMe(meRes.user);
    const cRes = await api("/api/chats", { token: t });
    setChats(cRes.chats);
  }

  function setupSocket(t) {
    const s = makeSocket(t);
    socketRef.current = s;

    s.on("connect", () => {});
    s.on("message", (msg) => {
      if (activeChat?.id === msg.chat_id) setMessages((p) => [...p, msg]);
      // refresh chat subtitle
      setChats((p) =>
        p.map((c) =>
          c.id === msg.chat_id
            ? { ...c, subtitle: msg.kind === "text" ? msg.text : msg.kind === "image" ? "Photo" : msg.kind === "voice" ? "Voice" : "File" }
            : c
        )
      );
    });

    // signaling: incoming offer
    s.on("call_offer", ({ chatId, fromUserId, offer }) => {
      // показываем тост "входящий звонок"
      setIncoming({ chatId, fromUserId, offer });
    });

    s.on("call_answer", async ({ chatId, answer }) => {
      try {
        const pc = pcRef.current;
        if (!pc) return;
        await pc.setRemoteDescription(answer);
      } catch (e) {
        console.warn(e);
      }
    });

    s.on("ice_candidate", async ({ candidate }) => {
      try {
        const pc = pcRef.current;
        if (!pc) return;
        await pc.addIceCandidate(candidate);
      } catch (e) {
        console.warn(e);
      }
    });

    s.connect();
  }
async function getLocalStream() {
  if (localStreamRef.current) return localStreamRef.current;
  const s = await navigator.mediaDevices.getUserMedia({ video: true, audio: true });
  localStreamRef.current = s;
  setLocalReady(true);
  return s;
}

function ensureRemoteStream() {
  if (!remoteStreamRef.current) remoteStreamRef.current = new MediaStream();
  return remoteStreamRef.current;
}

function cleanupCall() {
  try { pcRef.current?.close(); } catch (e) {}
  pcRef.current = null;
  try {
    localStreamRef.current?.getTracks()?.forEach((t) => t.stop());
  } catch (e) {}
  localStreamRef.current = null;
  remoteStreamRef.current = null;
  setLocalReady(false);
  setRemoteReady(false);
  setIncoming(null);
  setCall(null);
}

async function makePeerConnection(chatId) {
  if (pcRef.current) return pcRef.current;

  const pc = new RTCPeerConnection({
    iceServers: [
      { urls: "stun:stun.l.google.com:19302" },
      { urls: "stun:stun1.l.google.com:19302" },
    ],
  });

  const remote = ensureRemoteStream();

  pc.ontrack = (ev) => {
    ev.streams[0].getTracks().forEach((t) => remote.addTrack(t));
    setRemoteReady(true);
  };

  pc.onicecandidate = (ev) => {
    if (ev.candidate) {
      socketRef.current?.emit("ice_candidate", { chatId, candidate: ev.candidate });
    }
  };

  const local = await getLocalStream();
  local.getTracks().forEach((t) => pc.addTrack(t, local));

  pcRef.current = pc;
  return pc;
}

async function startCall(chatId, peerName) {
  try {
    const pc = await makePeerConnection(chatId);
    const offer = await pc.createOffer();
    await pc.setLocalDescription(offer);
    setCall({ chatId, peerName, role: "caller" });
    socketRef.current?.emit("call_offer", { chatId, offer });
  } catch (e) {
    alert("Не удалось начать звонок: " + e.message);
    cleanupCall();
  }
}

async function acceptCall(chatId, peerName, offer) {
  try {
    const pc = await makePeerConnection(chatId);
    await pc.setRemoteDescription(offer);
    const answer = await pc.createAnswer();
    await pc.setLocalDescription(answer);
    setCall({ chatId, peerName, role: "callee" });
    socketRef.current?.emit("call_answer", { chatId, answer });
  } catch (e) {
    alert("Не удалось принять звонок: " + e.message);
    cleanupCall();
  }
}


  useEffect(() => {
    (async () => {
      if (!token) return;
      try {
        await loadMeAndChats(token);
        setRoute("app");
        setupSocket(token);
      } catch (e) {
        localStorage.removeItem("sizero_token");
        setToken("");
        setRoute("auth");
      }
    })();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  async function openChat(chat) {
    setActiveChat(chat);
    const r = await api(`/api/messages/${chat.id}`, { token });
    setMessages(r.messages);
    socketRef.current?.emit("join_chat", { chatId: chat.id });
  }

  async function deleteChat(chatId) {
    await api(`/api/chats/${chatId}`, { method: "DELETE", token });
    setChats((p) => p.filter((c) => c.id !== chatId));
    if (activeChat?.id === chatId) {
      setActiveChat(null);
      setMessages([]);
    }
  }



  async function removeChat(chat) {
    if (!chat) return;
    if (chat.type === 'channel') {
      await api(`/api/channels/${chat.id}/unsubscribe`, { method: 'POST', token });
    } else if (chat.type === 'group') {
      await api(`/api/groups/${chat.id}/leave`, { method: 'POST', token });
    } else {
      await deleteChat(chat.id);
      return;
    }
    // refresh list
    const cRes = await api('/api/chats', { token });
    setChats(cRes.chats);
    if (activeChat?.id === chat.id) {
      setActiveChat(null);
      setMessages([]);
    }
  }

  async function openGroupModal() {
    setGroupTitle('');
    setGroupQuery('');
    setGroupResults([]);
    setGroupSelected({});
    setUiModal('group');
  }

  async function openChannelModal() {
    setChannelTitle('');
    setChannelSlug('');
    setUiModal('channel');
  }

  async function openCatalogModal() {
    setCatalogQuery('');
    setCatalogChannels([]);
    setUiModal('catalog');
    // initial load
    const r = await api('/api/channels', { token });
    setCatalogChannels(r.channels);
  }

  async function searchGroupUsers() {
    const q = groupQuery.trim();
    if (!q) return setGroupResults([]);
    const r = await api(`/api/users/search?q=${encodeURIComponent(q)}`, { token });
    setGroupResults(r.users);
  }

  async function createGroup() {
    const ids = Object.keys(groupSelected).filter((k) => groupSelected[k]).map((x) => Number(x));
    const r = await api('/api/groups', { method: 'POST', token, body: { title: groupTitle, memberIds: ids } });
    setUiModal(null);
    await loadMeAndChats(token);
    // auto-open
    const chat = { id: r.chat.id, type: 'group', title: r.chat.title, slug: r.chat.slug || '', is_public: !!r.chat.is_public };
    await openChat(chat);
  }

  async function createChannel() {
    const r = await api('/api/channels', { method: 'POST', token, body: { title: channelTitle, slug: channelSlug, isPublic: true } });
    setUiModal(null);
    await loadMeAndChats(token);
    const chat = { id: r.chat.id, type: 'channel', title: `#${r.chat.slug}`, slug: r.chat.slug, is_public: true };
    await openChat(chat);
  }

  async function searchChannels() {
    const r = await api(`/api/channels?q=${encodeURIComponent(catalogQuery)}`, { token });
    setCatalogChannels(r.channels);
  }

  async function toggleSubscribe(ch) {
    if (ch.subscribed) {
      await api(`/api/channels/${ch.id}/unsubscribe`, { method: 'POST', token });
    } else {
      await api(`/api/channels/${ch.id}/subscribe`, { method: 'POST', token });
    }
    const r = await api(`/api/channels?q=${encodeURIComponent(catalogQuery)}`, { token });
    setCatalogChannels(r.channels);
    await loadMeAndChats(token);
  }
  function logout() {
    socketRef.current?.disconnect();
    socketRef.current = null;
    localStorage.removeItem("sizero_token");
    setToken("");
    setMe(null);
    setChats([]);
    setActiveChat(null);
    setMessages([]);
    setRoute("auth");
  }

  return (
    <div className="min-h-screen w-full bg-[#1f2326] text-white overflow-hidden relative">
      <style>{`
        .sz-font { font-family: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, "Liberation Mono", "Courier New", monospace; }
        .sz-pixel { font-family: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, "Liberation Mono", "Courier New", monospace; letter-spacing: .08em; }
        .sz-card { box-shadow: 0 18px 40px rgba(0,0,0,.55); }
        .sz-glow-blue { box-shadow: 0 0 0 1px rgba(90,155,255,.25), 0 0 40px rgba(90,155,255,.22); }
        .sz-glow-mix { box-shadow: 0 0 0 1px rgba(90,155,255,.22), 0 0 50px rgba(90,155,255,.20), 0 0 45px rgba(255,140,0,.18); }
        .sz-focus-orange:focus { outline: none; box-shadow: 0 0 0 2px rgba(255,140,0,.65); }
        .sz-focus-blue:focus { outline: none; box-shadow: 0 0 0 2px rgba(90,155,255,.60); }
      `}</style>

      {Bg}

      <AnimatePresence mode="wait">
        {route === "auth" ? (
          <motion.div key="auth" initial={{ opacity: 0, y: 8 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0, y: -8 }} transition={{ duration: 0.18 }} className="relative z-10 min-h-screen flex items-center justify-center p-6">
            <AuthCard
              mode={authMode}
              onMode={setAuthMode}
              onAuthed={async (t) => {
                setToken(t);
                localStorage.setItem("sizero_token", t);
                await loadMeAndChats(t);
                setupSocket(t);
                setRoute("app");
              }}
            />
          </motion.div>
        ) : (
          <motion.div key="app" initial={{ opacity: 0, y: 8 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0, y: -8 }} transition={{ duration: 0.18 }} className="relative z-10 min-h-screen">
            <TopBar me={me} onSettings={() => setProfileOpen(true)} onLogout={logout} />

            <UiModals
              open={uiModal}
              onClose={() => setUiModal(null)}
              token={token}
              groupTitle={groupTitle}
              setGroupTitle={setGroupTitle}
              groupQuery={groupQuery}
              setGroupQuery={setGroupQuery}
              groupResults={groupResults}
              groupSelected={groupSelected}
              setGroupSelected={setGroupSelected}
              onSearchGroupUsers={searchGroupUsers}
              onCreateGroup={createGroup}
              channelTitle={channelTitle}
              setChannelTitle={setChannelTitle}
              channelSlug={channelSlug}
              setChannelSlug={setChannelSlug}
              onCreateChannel={createChannel}
              catalogQuery={catalogQuery}
              setCatalogQuery={setCatalogQuery}
              catalogChannels={catalogChannels}
              onSearchChannels={searchChannels}
              onToggleSubscribe={toggleSubscribe}
            />

            <div className="h-[calc(100vh-44px)] grid grid-cols-1 md:grid-cols-[280px_1fr]">
              <div className={cx(isMobile ? (activeChat ? "hidden" : "block") : "block", "md:block")}>
                <Sidebar
                  chats={chats}
                  activeChatId={activeChat?.id || null}
                  onOpen={openChat}
                  onRemove={removeChat}
                  onNewGroup={openGroupModal}
                  onNewChannel={openChannelModal}
                  onBrowseChannels={openCatalogModal}
                />
              </div>

              <div className={cx(isMobile ? (activeChat ? "block" : "hidden") : "block")}>
                <MainPanel
                  me={me}
                  token={token}
                  chat={activeChat}
                  messages={messages}
                  showBack={isMobile}
                  onBack={() => setActiveChat(null)}
                  onSend={(payload) => {
                    if (!activeChat) return;
                    socketRef.current?.emit("send_message", { chatId: activeChat.id, ...payload }, () => {});
                  }}
                  onDeleteChat={() => activeChat && deleteChat(activeChat.id)}
                  onTestIncoming={() => {
                    if (!activeChat) return;
                    startCall(activeChat.id, activeChat.title);
                  }}
                  onCall={() => {
                    if (!activeChat) return;
                    startCall(activeChat.id, activeChat.title);
                  }}
                />
              </div>
            </div>

            <AnimatePresence>
              {profileOpen && me && (
                <ModalOverlay onClose={() => setProfileOpen(false)}>
                  <ProfileModal
                    me={me}
                    token={token}
                    onClose={() => setProfileOpen(false)}
                    onSave={(u) => {
                      setMe(u);
                      setProfileOpen(false);
                    }}
                  />
                </ModalOverlay>
              )}
            </AnimatePresence>

            <AnimatePresence>
              {incoming && (
                <IncomingCallToast
                  name={activeChat?.title || "User"}
                  onAccept={async () => {
                    const chatId = incoming.chatId;
                    const peerName = activeChat?.title || "User";
                    await acceptCall(chatId, peerName, incoming.offer);
                    setIncoming(null);
                  }}
                  onClose={() => setIncoming(null)}
                />
              )}
            </AnimatePresence>

            
<AnimatePresence>
              {call && (
                <ModalOverlay onClose={cleanupCall}>
                  <CallModal
                    peerName={activeChat?.title || "User"}
                    localStream={localStreamRef.current}
                    remoteStream={remoteStreamRef.current}
                    localReady={localReady}
                    remoteReady={remoteReady}
                    onHangup={cleanupCall}
                  />
                </ModalOverlay>
              )}
            </AnimatePresence>
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}

function AuthCard({ mode, onMode, onAuthed }) {
  const [username, setUsername] = useState("mono23");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");

  async function submit() {
    if (mode === "register") {
      const r = await api("/api/auth/register", { method: "POST", body: { username, email, password } });
      onAuthed(r.token);
    } else {
      const r = await api("/api/auth/login", { method: "POST", body: { email, password } });
      onAuthed(r.token);
    }
  }

  return (
    <div className="w-full max-w-sm">
      <div className="sz-card sz-glow-mix rounded-[10px] bg-[#3a3f44] border border-white/10 overflow-hidden">
        <div className="h-[5px] bg-gradient-to-r from-sky-500 via-sky-500 to-orange-500" />
        <div className="p-5">
          <div className="sz-pixel text-center text-[18px] mb-4 opacity-95">JOIN SIZERO</div>

          <div className="space-y-3">
            <Field label="USERNAME" color="orange">
              <input className="w-full h-9 rounded-[4px] bg-white text-[#111] px-3 text-sm sz-font sz-focus-blue" value={username} onChange={(e) => setUsername(e.target.value)} />
            </Field>

            {mode === "register" && (
              <Field label="EMAIL" color="sky">
                <input className="w-full h-9 rounded-[4px] bg-[#4b5056] text-white px-3 text-sm sz-font sz-focus-orange border border-orange-500/70" placeholder="ENTER EMAIL…" value={email} onChange={(e) => setEmail(e.target.value)} />
              </Field>
            )}

            <Field label="PASSWORD" color="orange">
              <input type="password" className="w-full h-9 rounded-[4px] bg-white text-[#111] px-3 text-sm sz-font sz-focus-blue" value={password} onChange={(e) => setPassword(e.target.value)} />
            </Field>

            <button onClick={submit} className="w-full h-10 rounded-[4px] bg-[#12d6ff] text-[#0b0f12] font-semibold shadow-[0_6px_0_rgba(0,0,0,.35)]">
              {mode === "register" ? "CREATE ACCOUNT" : "LOGIN"}
            </button>

            <div className="text-center text-[11px] opacity-75">
              {mode === "register" ? (
                <>ALREADY A PLAYER? <button className="text-orange-400 hover:text-orange-300" onClick={() => onMode("login")}>LOGIN HERE</button></>
              ) : (
                <>NEED AN ACCOUNT? <button className="text-orange-400 hover:text-orange-300" onClick={() => onMode("register")}>REGISTER</button></>
              )}
            </div>
          </div>
        </div>
      </div>

      <div className="mt-3 text-center text-xs opacity-60">Это реальный backend — зарегистрируй 2 аккаунта в разных вкладках и пиши друг другу.</div>
    </div>
  );
}

function Field({ label, color, children }) {
  const c = color === "orange" ? "text-orange-400" : "text-sky-400";
  return (
    <div>
      <div className={cx("text-[11px] mb-1 font-semibold", c, "sz-font")}>{label}</div>
      {children}
    </div>
  );
}

function TopBar({ me, onSettings, onLogout }) {
  return (
    <div className="h-[44px] bg-[#2a2f33] border-b border-white/10 flex items-center justify-between px-3">
      <div className="flex items-center gap-2 min-w-0">
        <div className="h-7 w-7 rounded-full bg-[#3b4046] border border-white/10 flex items-center justify-center text-xs overflow-hidden">
          {me?.avatar_url ? <img src={me.avatar_url} className="h-full w-full object-cover" /> : initials(me?.username)}
        </div>
        <div className="text-sm font-semibold truncate">{me?.username || ""}</div>
      </div>

      <div className="flex items-center gap-1">
        <IconBtn title="Profile" onClick={onSettings}><Settings className="h-4 w-4" /></IconBtn>
        <IconBtn title="Logout" onClick={onLogout}><LogOut className="h-4 w-4" /></IconBtn>
      </div>
    </div>
  );
}

function IconBtn({ children, title, onClick }) {
  return (
    <button title={title} onClick={onClick} className="h-8 w-8 rounded-md hover:bg-white/10 active:bg-white/15 flex items-center justify-center" type="button">
      {children}
    </button>
  );
}

function Sidebar({ chats, activeChatId, onOpen, onRemove, onNewGroup, onNewChannel, onBrowseChannels }) {
  const [q, setQ] = useState("");
  const filtered = useMemo(() => {
    const s = q.trim().toLowerCase();
    if (!s) return chats;
    return chats.filter((c) => `${c.title} ${c.subtitle}`.toLowerCase().includes(s));
  }, [q, chats]);

  return (
    <div className="bg-[#3a3f44] border-r border-white/10">
      <div className="p-2">
        <div className="relative">
          <Search className="absolute left-2 top-1/2 -translate-y-1/2 h-4 w-4 opacity-70" />
          <input value={q} onChange={(e) => setQ(e.target.value)} placeholder="SEARCH USERS..." className="w-full h-8 pl-8 pr-2 rounded-[4px] bg-[#3a3f44] border border-sky-500/70 text-sm sz-font sz-focus-blue" />
        </div>
      </div>

      <div className="px-3 pb-2 flex gap-2">
        <button onClick={onNewGroup} className="flex-1 h-8 rounded-[4px] bg-[#2a2f33] border border-white/10 text-[11px] sz-font hover:border-sky-500/60">+ GROUP</button>
        <button onClick={onNewChannel} className="flex-1 h-8 rounded-[4px] bg-[#2a2f33] border border-white/10 text-[11px] sz-font hover:border-sky-500/60">+ CHANNEL</button>
      </div>
      <div className="px-3 pb-3">
        <button onClick={onBrowseChannels} className="w-full h-8 rounded-[4px] bg-[#2a2f33] border border-white/10 text-[11px] sz-font hover:border-orange-400/70">BROWSE CHANNELS</button>
      </div>

      <div className="px-1 pb-2">
        {filtered.map((c) => (
          <div key={c.id} className={cx("relative mx-1 my-1 rounded-md", c.id === activeChatId ? "bg-[#4b5056]" : "hover:bg-white/5")}>
            {c.id === activeChatId && <div className="absolute left-0 top-0 bottom-0 w-[3px] bg-orange-400/90 rounded-l-md" />}
            <button onClick={() => onOpen(c)} className="w-full text-left px-3 py-2 flex items-center gap-3" type="button">
              <div className="h-10 w-10 rounded-full bg-[#5a6068] flex items-center justify-center text-xs overflow-hidden">
                {c.peer?.avatar_url ? <img src={c.peer.avatar_url} className="h-full w-full object-cover" /> : initials(c.title)}
              </div>
              <div className="min-w-0 flex-1">
                <div className="text-sm font-semibold truncate">{c.title}</div>
                <div className="text-[11px] opacity-70 truncate">{c.subtitle || "Last message…"}</div>
              </div>
            </button>
            <div className="px-3 pb-2 flex items-center justify-end">
              <button className="text-[11px] text-orange-300/80 hover:text-orange-300" onClick={() => onRemove(c)} type="button">{c.type === "dm" ? "Delete" : c.type === "group" ? "Leave" : "Unsubscribe"}</button>
            </div>
          </div>
        ))}
        {!filtered.length && <div className="px-3 py-4 text-xs opacity-70">Ничего не найдено.</div>}
      </div>
    </div>
  );
}

function MainPanel({ me, token, chat, messages, onSend, onDeleteChat, onTestIncoming, onCall, showBack = false, onBack }) {
  const [searchUser, setSearchUser] = useState("");
  const [results, setResults] = useState([]);

  async function doSearch() {
    const q = searchUser.trim();
    if (!q) return setResults([]);
    const r = await api(`/api/users/search?q=${encodeURIComponent(q)}`, { token });
    setResults(r.users);
  }

  if (!chat) {
    return (
      <div className="bg-[#1f2326] flex flex-col items-center justify-center gap-4">
        <div className="text-center opacity-70">
          <div className="mx-auto h-14 w-14 rounded-full bg-black/20 border border-white/10 flex items-center justify-center"><div className="text-sm sz-font">S</div></div>
          <div className="mt-3 text-[12px] sz-font">SELECT A CHAT TO START</div>
        </div>

        <div className="w-[520px] max-w-[90%] sz-card rounded-[10px] bg-[#2a2f33] border border-white/10 p-4">
          <div className="text-xs sz-font opacity-80 mb-2">Создать DM: введи username и нажми Search</div>
          <div className="flex gap-2">
            <input className="flex-1 h-9 rounded-[4px] bg-[#2a2f33] border border-sky-500/60 px-3 text-sm sz-font sz-focus-blue" placeholder="SEARCH USERS..." value={searchUser} onChange={(e) => setSearchUser(e.target.value)} />
            <button className="h-9 px-3 rounded-[4px] bg-[#12d6ff] text-[#0b0f12] font-semibold" onClick={doSearch}>Search</button>
          </div>
          {results.length > 0 && (
            <div className="mt-3 space-y-2">
              {results.map((u) => (
                <DmRow key={u.id} user={u} token={token} />
              ))}
            </div>
          )}
        </div>
      </div>
    );
  }

  return (
    <div className="bg-[#1f2326] relative flex flex-col h-full">
      <div className="h-[44px] bg-[#2a2f33] border-b border-white/10 flex items-center justify-between px-3">
        <div className="flex items-center gap-2 min-w-0">
          <div className="h-7 w-7 rounded-full bg-[#3b4046] border border-white/10 flex items-center justify-center text-xs overflow-hidden">
            {chat.peer?.avatar_url ? <img src={chat.peer.avatar_url} className="h-full w-full object-cover" /> : initials(chat.title)}
          </div>
          <div className="min-w-0">
            <div className="text-sm font-semibold truncate">{chat.title}</div>
            <div className="text-[11px] text-sky-400 sz-font">ONLINE</div>
          </div>
        </div>

        <div className="flex items-center gap-1">
          <IconBtn title="Test incoming" onClick={onTestIncoming}><ChevronDown className="h-4 w-4 opacity-80" /></IconBtn>
          <IconBtn title="Call" onClick={onCall}><Phone className="h-4 w-4" /></IconBtn>
          <IconBtn title="Delete chat" onClick={onDeleteChat}><Trash2 className="h-4 w-4" /></IconBtn>
        </div>
      </div>

      <MessagesView me={me} messages={messages} />
      <Composer token={token} onSend={onSend} myName={me.username} />
    </div>
  );
}

function DmRow({ user, token }) {
  async function create() {
    await api("/api/chats/dm", { method: "POST", body: { username: user.username }, token });
    window.location.reload(); // simplest refresh to fetch chats list
  }
  return (
    <button onClick={create} className="w-full text-left rounded-md bg-white/5 hover:bg-white/10 border border-white/10 px-3 py-2 flex items-center gap-3" type="button">
      <div className="h-9 w-9 rounded-full bg-[#5a6068] flex items-center justify-center text-xs overflow-hidden">
        {user.avatar_url ? <img src={user.avatar_url} className="h-full w-full object-cover" /> : initials(user.username)}
      </div>
      <div className="min-w-0 flex-1">
        <div className="text-sm font-semibold truncate">{user.username}</div>
        <div className="text-[11px] opacity-70 truncate">{user.about || ""}</div>
      </div>
      <div className="text-xs opacity-70">Start</div>
    </button>
  );
}

function MessagesView({ me, messages }) {
  const ref = useRef(null);
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    el.scrollTop = el.scrollHeight;
  }, [messages.length]);

  return (
    <div ref={ref} className="flex-1 overflow-y-auto px-4 py-4">
      <div className="space-y-3">
        {messages.map((m) => (
          <MessageBubble key={m.id} me={me} msg={m} />
        ))}
      </div>
    </div>
  );
}

function MessageBubble({ me, msg }) {
  const mine = msg.sender_id === me.id || msg.from === "me";
  return (
    <div className={cx("w-full flex", mine ? "justify-end" : "justify-start")}>
      <div className={cx("max-w-[85%] sm:max-w-[420px] rounded-md px-3 py-2 border", mine ? "bg-[#2b79a6] border-[#2b79a6]" : "bg-[#3a3f44] border-white/10")}>
        {!mine && <div className="text-[11px] font-semibold sz-font text-orange-300">{msg.sender_username || ""}</div>}

        {msg.kind === "text" && <div className="text-sm leading-snug sz-font whitespace-pre-wrap">{msg.text}</div>}

        {msg.kind === "image" && <img src={msg.file_url} alt={msg.file_name || "image"} className="max-h-[260px] rounded-md border border-white/10 object-cover" />}

        {msg.kind === "file" && (
          <div className="flex items-center gap-2">
            <div className="h-9 w-9 rounded-md bg-black/20 border border-white/10 flex items-center justify-center">📎</div>
            <div className="min-w-0">
              <div className="text-sm font-semibold sz-font truncate">{msg.file_name}</div>
              <div className="text-[11px] opacity-70 sz-font">{msg.file_size ? `${msg.file_size} B` : ""}</div>
            </div>
          </div>
        )}

        {msg.kind === "voice" && <VoiceBubble url={msg.file_url} duration={msg.duration_sec} />}

        <div className="text-[10px] opacity-70 mt-1 text-right sz-font">{new Date(msg.created_at || Date.now()).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}</div>
      </div>
    </div>
  );
}

function VoiceBubble({ url, duration }) {
  const aRef = useRef(null);
  const [playing, setPlaying] = useState(false);

  useEffect(() => {
    const a = aRef.current;
    if (!a) return;
    const onEnd = () => setPlaying(false);
    a.addEventListener("ended", onEnd);
    return () => a.removeEventListener("ended", onEnd);
  }, []);

  return (
    <div className="mt-1 rounded-md bg-[#d7d7d7] text-[#111] px-2 py-2 border border-black/10">
      <div className="flex items-center gap-2">
        <button
          onClick={() => {
            const a = aRef.current;
            if (!a) return;
            if (playing) {
              a.pause();
              setPlaying(false);
            } else {
              a.play();
              setPlaying(true);
            }
          }}
          className="h-7 w-7 rounded-full bg-white border border-black/10 flex items-center justify-center"
          type="button"
        >
          {playing ? "❚❚" : "▶"}
        </button>
        <div className="flex-1">
          <div className="h-1.5 rounded-full bg-black/10" />
          <div className="mt-1 text-[11px] sz-font opacity-80">{mmss(duration)}</div>
        </div>
        <button className="h-7 w-7 rounded-full bg-white border border-black/10" type="button" title="Menu">⋮</button>
        <audio ref={aRef} src={url} preload="metadata" />
      </div>
    </div>
  );
}

function Composer({ token, onSend, myName }) {
  const [text, setText] = useState("");
  const imgInputRef = useRef(null);
  const fileInputRef = useRef(null);

  const [rec, setRec] = useState({ state: "idle", sec: 0 });
  const [voiceBlob, setVoiceBlob] = useState(null);
  const mediaRef = useRef(null);
  const chunksRef = useRef([]);
  const tRef = useRef(null);

  useEffect(() => {
    return () => {
      if (tRef.current) clearInterval(tRef.current);
      try {
        if (mediaRef.current && mediaRef.current.state !== "inactive") mediaRef.current.stop();
      } catch (e) {}
    };
  }, []);

  function sendText() {
    const t = text.trim();
    if (!t) return;
    onSend({ kind: "text", text: t });
    setText("");
  }

  async function startRec() {
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      const mr = new MediaRecorder(stream);
      chunksRef.current = [];

      mr.ondataavailable = (e) => {
        if (e.data && e.data.size > 0) chunksRef.current.push(e.data);
      };

      mr.onstop = () => {
        const blob = new Blob(chunksRef.current, { type: mr.mimeType || "audio/webm" });
        setVoiceBlob(blob);
        setRec((p) => ({ ...p, state: "ready" }));
        stream.getTracks().forEach((t) => t.stop());
      };

      mediaRef.current = mr;
      mr.start();
      setVoiceBlob(null);
      setRec({ state: "recording", sec: 0 });

      tRef.current = setInterval(() => setRec((p) => ({ ...p, sec: Math.min(599, p.sec + 1) })), 1000);
    } catch (e) {
      alert("Разреши доступ к микрофону.");
    }
  }

  function stopRec() {
    try {
      if (tRef.current) clearInterval(tRef.current);
      tRef.current = null;
      if (mediaRef.current && mediaRef.current.state !== "inactive") mediaRef.current.stop();
    } catch (e) {}
  }

  function cancelVoice() {
    if (tRef.current) clearInterval(tRef.current);
    tRef.current = null;
    setRec({ state: "idle", sec: 0 });
    setVoiceBlob(null);
  }

  async function sendVoice() {
    if (!voiceBlob) return;
    const file = new File([voiceBlob], `voice_${Date.now()}.webm`, { type: voiceBlob.type || "audio/webm" });
    const up = await uploadFile(file, token);
    onSend({ kind: "voice", fileUrl: up.url, fileName: up.name, fileSize: up.size, mime: up.mime, durationSec: rec.sec });
    setVoiceBlob(null);
    setRec({ state: "idle", sec: 0 });
  }

  async function sendImage(file) {
    const up = await uploadFile(file, token);
    onSend({ kind: "image", fileUrl: up.url, fileName: up.name, fileSize: up.size, mime: up.mime });
  }

  async function sendFile(file) {
    const up = await uploadFile(file, token);
    onSend({ kind: "file", fileUrl: up.url, fileName: up.name, fileSize: up.size, mime: up.mime });
  }

  return (
    <div className="h-[64px] border-t border-white/10 bg-[#2a2f33] px-3 flex items-center gap-2">
      <input ref={imgInputRef} type="file" accept="image/*" className="hidden" onChange={(e) => { const f = e.target.files?.[0]; if (f) sendImage(f); e.target.value = ""; }} />
      <input ref={fileInputRef} type="file" className="hidden" onChange={(e) => { const f = e.target.files?.[0]; if (f) sendFile(f); e.target.value = ""; }} />

      <button className="h-8 w-8 rounded-md hover:bg-white/10 flex items-center justify-center" onClick={() => fileInputRef.current?.click()} type="button" title="Attach file">
        <Paperclip className="h-4 w-4" />
      </button>

      <button className="h-8 w-8 rounded-md hover:bg-white/10 flex items-center justify-center" onClick={() => imgInputRef.current?.click()} type="button" title="Send photo">
        <Camera className="h-4 w-4" />
      </button>

      <div className="flex-1">
        <input value={text} onChange={(e) => setText(e.target.value)} placeholder="TYPE A MESSAGE..." className="w-full h-9 rounded-[4px] bg-[#2a2f33] border border-sky-500/60 px-3 text-sm sz-font sz-focus-blue" onKeyDown={(e) => e.key === "Enter" && sendText()} />
      </div>

      <div className="flex items-center gap-2">
        {rec.state === "idle" && (
          <button className="h-8 w-8 rounded-md hover:bg-white/10 flex items-center justify-center" onClick={startRec} type="button" title="Voice">
            <Mic className="h-4 w-4" />
          </button>
        )}

        {rec.state === "recording" && (
          <div className="flex items-center gap-2">
            <div className="text-xs sz-font opacity-80">REC {mmss(rec.sec)}</div>
            <button className="h-8 px-3 rounded-md bg-orange-500/90 text-[#0b0f12] font-semibold" onClick={stopRec} type="button">Stop</button>
            <button className="h-8 w-8 rounded-md hover:bg-white/10" onClick={cancelVoice} type="button" title="Cancel"><X className="h-4 w-4 mx-auto" /></button>
          </div>
        )}

        {rec.state === "ready" && (
          <div className="flex items-center gap-2">
            <div className="text-xs sz-font opacity-80">VOICE {mmss(rec.sec)}</div>
            <button className="h-8 px-3 rounded-md bg-emerald-400 text-[#0b0f12] font-semibold" onClick={sendVoice} type="button">Send</button>
            <button className="h-8 w-8 rounded-md hover:bg-white/10" onClick={cancelVoice} type="button" title="Cancel"><X className="h-4 w-4 mx-auto" /></button>
          </div>
        )}

        <button className="h-9 w-9 rounded-md bg-[#f0a500] text-[#0b0f12] flex items-center justify-center shadow-[0_6px_0_rgba(0,0,0,.35)]" onClick={sendText} type="button" title="Send">
          <Send className="h-4 w-4" />
        </button>
      </div>
    </div>
  );
}


function UiModals({
  open,
  onClose,
  token,
  groupTitle,
  setGroupTitle,
  groupQuery,
  setGroupQuery,
  groupResults,
  groupSelected,
  setGroupSelected,
  onSearchGroupUsers,
  onCreateGroup,
  channelTitle,
  setChannelTitle,
  channelSlug,
  setChannelSlug,
  onCreateChannel,
  catalogQuery,
  setCatalogQuery,
  catalogChannels,
  onSearchChannels,
  onToggleSubscribe,
}) {
  if (!open) return null;

  if (open === "group") {
    return (
      <ModalOverlay onClose={onClose}>
        <div className="w-[560px] max-w-[92vw] sz-card rounded-[10px] bg-[#2a2f33] border border-white/10 p-4">
          <div className="flex items-center justify-between mb-3">
            <div className="text-sm font-semibold">New group chat</div>
            <button onClick={onClose} className="p-1 hover:bg-white/10 rounded"><X className="h-4 w-4" /></button>
          </div>

          <div className="space-y-3">
            <input value={groupTitle} onChange={(e) => setGroupTitle(e.target.value)} placeholder="Group title" className="w-full h-9 rounded-[4px] bg-[#1f2326] border border-white/10 px-3 text-sm sz-font sz-focus-blue" />

            <div className="flex gap-2">
              <input value={groupQuery} onChange={(e) => setGroupQuery(e.target.value)} placeholder="Search users to add" className="flex-1 h-9 rounded-[4px] bg-[#1f2326] border border-sky-500/50 px-3 text-sm sz-font sz-focus-blue" />
              <button onClick={onSearchGroupUsers} className="h-9 px-3 rounded-[4px] bg-[#12d6ff] text-[#0b0f12] font-semibold">Search</button>
            </div>

            {groupResults.length > 0 && (
              <div className="max-h-[260px] overflow-auto rounded-md border border-white/10">
                {groupResults.map((u) => (
                  <label key={u.id} className="flex items-center gap-3 px-3 py-2 hover:bg-white/5 cursor-pointer">
                    <input
                      type="checkbox"
                      checked={!!groupSelected[u.id]}
                      onChange={(e) => setGroupSelected((p) => ({ ...p, [u.id]: e.target.checked }))}
                    />
                    <div className="h-7 w-7 rounded-full bg-[#5a6068] overflow-hidden flex items-center justify-center text-[10px]">
                      {u.avatar_url ? <img src={u.avatar_url} className="h-full w-full object-cover" /> : initials(u.username)}
                    </div>
                    <div className="min-w-0 flex-1">
                      <div className="text-sm font-semibold truncate">{u.username}</div>
                      <div className="text-[11px] opacity-70 truncate">{u.about || ""}</div>
                    </div>
                  </label>
                ))}
              </div>
            )}

            <div className="flex justify-end gap-2">
              <button onClick={onClose} className="h-9 px-3 rounded-[4px] bg-white/5 border border-white/10">Cancel</button>
              <button onClick={onCreateGroup} className="h-9 px-3 rounded-[4px] bg-orange-400 text-[#0b0f12] font-semibold">Create</button>
            </div>
          </div>
        </div>
      </ModalOverlay>
    );
  }

  if (open === "channel") {
    return (
      <ModalOverlay onClose={onClose}>
        <div className="w-[520px] max-w-[92vw] sz-card rounded-[10px] bg-[#2a2f33] border border-white/10 p-4">
          <div className="flex items-center justify-between mb-3">
            <div className="text-sm font-semibold">New channel</div>
            <button onClick={onClose} className="p-1 hover:bg-white/10 rounded"><X className="h-4 w-4" /></button>
          </div>

          <div className="space-y-3">
            <input value={channelTitle} onChange={(e) => setChannelTitle(e.target.value)} placeholder="Channel title" className="w-full h-9 rounded-[4px] bg-[#1f2326] border border-white/10 px-3 text-sm sz-font sz-focus-blue" />
            <input value={channelSlug} onChange={(e) => setChannelSlug(e.target.value)} placeholder="Slug (e.g. news, memes_24)" className="w-full h-9 rounded-[4px] bg-[#1f2326] border border-white/10 px-3 text-sm sz-font sz-focus-blue" />
            <div className="text-[11px] opacity-70">Slug: 3–32 символа, a-z, 0-9, _ или -</div>

            <div className="flex justify-end gap-2">
              <button onClick={onClose} className="h-9 px-3 rounded-[4px] bg-white/5 border border-white/10">Cancel</button>
              <button onClick={onCreateChannel} className="h-9 px-3 rounded-[4px] bg-orange-400 text-[#0b0f12] font-semibold">Create</button>
            </div>
          </div>
        </div>
      </ModalOverlay>
    );
  }

  // catalog
  return (
    <ModalOverlay onClose={onClose}>
      <div className="w-[640px] max-w-[95vw] sz-card rounded-[10px] bg-[#2a2f33] border border-white/10 p-4">
        <div className="flex items-center justify-between mb-3">
          <div className="text-sm font-semibold">Browse channels</div>
          <button onClick={onClose} className="p-1 hover:bg-white/10 rounded"><X className="h-4 w-4" /></button>
        </div>

        <div className="flex gap-2 mb-3">
          <input value={catalogQuery} onChange={(e) => setCatalogQuery(e.target.value)} placeholder="Search by title or slug" className="flex-1 h-9 rounded-[4px] bg-[#1f2326] border border-sky-500/50 px-3 text-sm sz-font sz-focus-blue" />
          <button onClick={onSearchChannels} className="h-9 px-3 rounded-[4px] bg-[#12d6ff] text-[#0b0f12] font-semibold">Search</button>
        </div>

        <div className="max-h-[420px] overflow-auto rounded-md border border-white/10">
          {catalogChannels.map((c) => (
            <div key={c.id} className="px-3 py-2 flex items-center gap-3 hover:bg-white/5">
              <div className="min-w-0 flex-1">
                <div className="text-sm font-semibold truncate">#{c.slug} <span className="opacity-70 font-normal">— {c.title}</span></div>
                <div className="text-[11px] opacity-60">{c.members} подписчиков</div>
              </div>
              <button
                onClick={() => onToggleSubscribe(c)}
                className={cx(
                  "h-8 px-3 rounded-[4px] border text-[11px] sz-font",
                  c.subscribed ? "bg-white/5 border-white/10 hover:border-orange-400/70" : "bg-orange-400 text-[#0b0f12] border-orange-400"
                )}
              >
                {c.subscribed ? "Unsubscribe" : "Subscribe"}
              </button>
            </div>
          ))}
          {!catalogChannels.length && <div className="px-3 py-6 text-xs opacity-70">Ничего не найдено.</div>}
        </div>
      </div>
    </ModalOverlay>
  );
}

function ModalOverlay({ children, onClose }) {
  return (
    <motion.div initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }} className="fixed inset-0 z-50 flex items-center justify-center">
      <div className="absolute inset-0 bg-black/55" onClick={onClose} />
      <div className="relative z-10">{children}</div>
    </motion.div>
  );
}

function ProfileModal({ me, token, onSave, onClose }) {
  const [username, setUsername] = useState(me.username);
  const [about, setAbout] = useState(me.about || "");
  const [avatarPreview, setAvatarPreview] = useState(me.avatar_url || "");

  async function save() {
    const r = await api("/api/profile", { method: "POST", token, body: { username, about } });
    onSave(r.user);
  }

  async function pickAvatar(file) {
    const r = await uploadAvatar(file, token);
    setAvatarPreview(r.user.avatar_url);
    onSave(r.user);
  }

  return (
    <motion.div initial={{ y: 10, opacity: 0 }} animate={{ y: 0, opacity: 1 }} exit={{ y: 10, opacity: 0 }} transition={{ duration: 0.18 }} className="sz-card sz-glow-blue w-[380px] rounded-[10px] bg-[#3a3f44] border border-white/10 overflow-hidden">
      <div className="p-4">
        <div className="flex items-center justify-between">
          <div className="sz-pixel text-sm">НАСТРОЙКИ ПРОФИЛЯ</div>
          <button className="opacity-70 hover:opacity-100" onClick={onClose} type="button"><X className="h-4 w-4" /></button>
        </div>

        <div className="mt-3 flex flex-col items-center">
          <label className="cursor-pointer">
            <input type="file" accept="image/*" className="hidden" onChange={(e) => { const f = e.target.files?.[0]; if (f) pickAvatar(f); e.target.value = ""; }} />
            <div className="h-14 w-14 rounded-full bg-[#2a2f33] border border-white/10 overflow-hidden flex items-center justify-center">
              {avatarPreview ? <img src={avatarPreview} className="h-full w-full object-cover" /> : <div className="text-xs">{initials(username)}</div>}
            </div>
          </label>
          <div className="mt-2 text-[11px] opacity-75 sz-font">НАЖМИТЕ, ЧТОБЫ ЗАГРУЗИТЬ АВАТАР</div>
        </div>

        <div className="mt-4 space-y-3">
          <div className="text-[11px] font-semibold text-sky-400 sz-font">ИМЯ ПОЛЬЗОВАТЕЛЯ</div>
          <input value={username} onChange={(e) => setUsername(e.target.value)} className="w-full h-9 rounded-[4px] bg-[#2a2f33] border border-sky-500/60 px-3 text-sm sz-font sz-focus-blue" />

          <div className="text-[11px] font-semibold text-sky-400 sz-font">О СЕБЕ</div>
          <textarea value={about} onChange={(e) => setAbout(e.target.value)} className="w-full min-h-[80px] rounded-[4px] bg-[#2a2f33] border border-sky-500/60 px-3 py-2 text-sm sz-font sz-focus-blue" />

          <button onClick={save} className="mt-2 w-full h-10 rounded-[6px] bg-[#f0a500] text-[#0b0f12] font-bold shadow-[0_8px_0_rgba(0,0,0,.35)] flex items-center justify-center gap-2" type="button">
            <Check className="h-4 w-4" /> СОХРАНИТЬ
          </button>
        </div>
      </div>
    </motion.div>
  );
}

function IncomingCallToast({ name, onAccept, onClose }) {
  return (
    <motion.div initial={{ opacity: 0, y: 16 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0, y: 16 }} className="fixed right-8 top-20 z-40">
      <div className="sz-card rounded-[10px] bg-[#3a3f44] border border-white/10 w-[420px] px-5 py-4 flex items-center justify-between">
        <div className="sz-pixel text-sm">INCOMING CALL FROM {name}…</div>
        <div className="flex items-center gap-2">
          <button onClick={onAccept} className="h-9 w-9 rounded-full bg-emerald-500 flex items-center justify-center" type="button" title="Accept"><Phone className="h-4 w-4" /></button>
          <button onClick={onClose} className="h-9 w-9 rounded-full bg-white/10 flex items-center justify-center" type="button" title="Close"><X className="h-4 w-4" /></button>
        </div>
      </div>
    </motion.div>
  );
}

function CallModal({ peerName, localStream, remoteStream, localReady, remoteReady, onHangup }) {
  const localVideoRef = useRef(null);
  const remoteVideoRef = useRef(null);
  const [micOn, setMicOn] = useState(true);
  const [camOn, setCamOn] = useState(true);

  useEffect(() => {
    if (localVideoRef.current && localStream) localVideoRef.current.srcObject = localStream;
  }, [localStream]);

  useEffect(() => {
    if (remoteVideoRef.current && remoteStream) remoteVideoRef.current.srcObject = remoteStream;
  }, [remoteStream]);

  function toggleMic() {
    const s = localStream;
    if (!s) return;
    const next = !micOn;
    s.getAudioTracks().forEach((t) => (t.enabled = next));
    setMicOn(next);
  }

  function toggleCam() {
    const s = localStream;
    if (!s) return;
    const next = !camOn;
    s.getVideoTracks().forEach((t) => (t.enabled = next));
    setCamOn(next);
  }

  return (
    <motion.div
      initial={{ y: 10, opacity: 0 }}
      animate={{ y: 0, opacity: 1 }}
      exit={{ y: 10, opacity: 0 }}
      transition={{ duration: 0.18 }}
      className="sz-card rounded-[12px] bg-[#3a3f44] border border-white/10 w-[780px] p-5"
    >
      <div className="sz-pixel text-center text-sm mb-4">CALL WITH {peerName}</div>

      <div className="grid grid-cols-2 gap-4">
        <div className="rounded-[10px] bg-black border border-orange-500/70 overflow-hidden relative h-[260px]">
          <video ref={localVideoRef} autoPlay playsInline muted className="h-full w-full object-cover" />
          <div className="absolute left-3 bottom-3 text-xs sz-font opacity-80">YOU {localReady ? "" : "(no cam/mic)"}</div>
        </div>

        <div className="rounded-[10px] bg-black border border-sky-500/70 overflow-hidden relative h-[260px]">
          <video ref={remoteVideoRef} autoPlay playsInline className="h-full w-full object-cover" />
          <div className="absolute left-3 bottom-3 text-xs sz-font opacity-80">{peerName} {remoteReady ? "" : "(connecting…)"}</div>
        </div>
      </div>

      <div className="mt-5 flex items-center justify-center gap-3">
        <button className="h-12 w-12 rounded-full bg-white/10 flex items-center justify-center" type="button" title="Mic" onClick={toggleMic}>
          <Mic className="h-5 w-5" />
        </button>
        <button className="h-12 w-12 rounded-full bg-white/10 flex items-center justify-center" type="button" title="Camera" onClick={toggleCam}>
          <Video className="h-5 w-5" />
        </button>
        <button className="h-14 w-14 rounded-full bg-red-500 flex items-center justify-center" onClick={onHangup} type="button" title="Hang up">
          <X className="h-6 w-6" />
        </button>
      </div>
    </motion.div>
  );
}
