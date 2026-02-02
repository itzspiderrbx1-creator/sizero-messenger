const API = "";

export async function api(path, { method="GET", body, token, isForm=false } = {}) {
  const headers = {};
  if (token) headers["Authorization"] = `Bearer ${token}`;
  if (body && !isForm) headers["Content-Type"] = "application/json";

  const res = await fetch(`${API}${path}`, {
    method,
    headers,
    body: body ? (isForm ? body : JSON.stringify(body)) : undefined
  });

  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data?.error || `HTTP ${res.status}`);
  return data;
}

export function uploadFile(file, token) {
  const fd = new FormData();
  fd.append("file", file);
  return api("/api/upload", { method: "POST", body: fd, token, isForm: true });
}

export function uploadAvatar(file, token) {
  const fd = new FormData();
  fd.append("file", file);
  return api("/api/profile/avatar", { method: "POST", body: fd, token, isForm: true });
}
