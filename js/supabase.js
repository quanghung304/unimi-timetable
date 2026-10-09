import { createClient } from "https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2.45.4/+esm";
import { SUPABASE_URL, SUPABASE_ANON_KEY } from "./config.js";

// "Remember me": when on, the session lives in localStorage and survives closing the
// browser (refresh tokens keep it alive); when off, it lives in sessionStorage only.
const REMEMBER_KEY = "tt.remember";
export const remember = {
  get() { try { return localStorage.getItem(REMEMBER_KEY) !== "0"; } catch { return true; } },
  set(on) { try { localStorage.setItem(REMEMBER_KEY, on ? "1" : "0"); } catch { /* ignore */ } },
};

const authStorage = {
  getItem(k) {
    try { return localStorage.getItem(k) ?? sessionStorage.getItem(k); } catch { return null; }
  },
  setItem(k, v) {
    try {
      const [keep, drop] = remember.get() ? [localStorage, sessionStorage] : [sessionStorage, localStorage];
      keep.setItem(k, v);
      drop.removeItem(k);
    } catch { /* storage blocked: session stays in memory */ }
  },
  removeItem(k) {
    try { localStorage.removeItem(k); sessionStorage.removeItem(k); } catch { /* ignore */ }
  },
};

export const sb = createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
  auth: { persistSession: true, autoRefreshToken: true, detectSessionInUrl: true, storage: authStorage },
});
