(() => {
  'use strict';

  const configuredApiBase = document.querySelector('meta[name="mindful-api-base"]')?.content?.trim();
  const hostname = window.location.hostname.toLowerCase();
  const isLocalPage = ['localhost', '127.0.0.1', '::1'].includes(hostname);
  const apiBase = (configuredApiBase || (isLocalPage ? `http://${hostname}:8001/api/v1` : '')).replace(/\/$/, '');
  const apiBaseError = (() => {
    if (!apiBase) return 'Sign-in is not configured for this website. Set its HTTPS API address and reload.';
    try {
      const url = new URL(apiBase);
      if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.search || url.hash || !url.pathname.replace(/\/$/, '').endsWith('/api/v1')) return 'The sign-in service address is invalid. Contact the site administrator.';
      if (window.location.protocol === 'https:' && url.protocol !== 'https:') return 'The sign-in service must use HTTPS on this website.';
      if (!isLocalPage && ['localhost', '127.0.0.1', '::1'].includes(url.hostname)) return 'The sign-in service address is invalid. Contact the site administrator.';
      return '';
    } catch (_) { return 'The sign-in service address is invalid. Contact the site administrator.'; }
  })();
  const loginGate = document.querySelector('#login-gate');
  const shell = document.querySelector('.shell');
  if (loginGate && !loginGate.hidden) shell?.classList.add('auth-mode');
  const message = document.querySelector('#auth-message');
  let appLoaded = false;
  let sessionCheckRunning = false;

  function showMessage(text, isError = false) {
    if (!message) return;
    message.textContent = text || '';
    message.classList.toggle('is-error', isError);
  }

  function csrfCookie() {
    const match = document.cookie.match(/(?:^|;\s*)mindful_csrf=([^;]+)/);
    return match ? decodeURIComponent(match[1]) : '';
  }

  async function request(path, options = {}) {
    if (apiBaseError) throw new Error(apiBaseError);
    const method = (options.method || 'GET').toUpperCase();
    const responseType = options.responseType;
    const fetchOptions = { ...options };
    delete fetchOptions.responseType;
    const headers = new Headers(options.headers || {});
    if (options.body && !(options.body instanceof FormData) && !headers.has('Content-Type')) headers.set('Content-Type', 'application/json');
    if (!['GET', 'HEAD', 'OPTIONS'].includes(method)) {
      const csrf = csrfCookie();
      if (csrf) headers.set('X-CSRF-Token', csrf);
    }
    let response;
    try {
      response = await fetch(`${apiBase}${path}`, { ...fetchOptions, method, headers, credentials: 'include', cache: 'no-store' });
    } catch (_) {
      throw new Error('Mindful could not reach its sign-in service. Check that the API is running and try again.');
    }
    if (response.status === 204) return null;
    if (responseType === 'blob' && response.ok) return response.blob();
    const payload = await response.json().catch(() => null);
   if (!response.ok) {

      const detail = payload?.detail;
      const message =
        typeof detail === 'string'
          ? detail
          : detail?.message || (response.status === 429 ? 'Too many attempts. Wait a moment and try again.' : `The sign-in service returned an error (${response.status}).`);

      throw new Error(message);
    }

    if (payload === null) throw new Error('The sign-in service returned an unreadable response. Try again later.');

    return payload;
  }

  async function loadProtectedExperience(user) {
    showMessage('Opening your private workspace…');
    setCurrentUser(user);
    document.querySelector('.sidebar')?.removeAttribute('hidden');
    document.querySelector('#primary-navigation')?.removeAttribute('hidden');
    if (!appLoaded) {
      await Promise.all([loadScript('app.js'), loadScript('roles.js')]);
      appLoaded = true;
    }
    bindSettings();
    if (loginGate) loginGate.hidden = true;
    shell?.classList.remove('auth-mode');
  }

  function setCurrentUser(user) {
    window.mindfulUser = Object.freeze({ id: user.id, email: user.email, display_name: user.display_name, role: user.role });
  }

  function bindSettings() {
    const user = window.mindfulUser;
    if (!user) return;
    const email = document.querySelector('#settings-email');
    const name = document.querySelector('#settings-display-name');
    if (email) email.value = user.email;
    if (name) name.value = user.display_name;
    const prefix = `mindful:${user.id}:`;
    const preferenceKey = `${prefix}privacy-preferences-v1`;
    const storedRecommendation = (() => { try { return JSON.parse(localStorage.getItem(preferenceKey) || '{}'); } catch (_) { return {}; } })();
    const recommendation = document.querySelector('#settings-recommend-journal');
    const contextToggle = document.querySelector('#recommendation-use-journal');
    if (recommendation) recommendation.checked = storedRecommendation.useJournalContext === true;
    if (contextToggle) contextToggle.checked = recommendation?.checked || false;
    const voice = document.querySelector('#settings-voice-enabled');
    try { window.mindfulVoiceEnabled = localStorage.getItem(`${prefix}voice-features-enabled-v1`) === 'true'; } catch (_) { window.mindfulVoiceEnabled = false; }
    if (voice) voice.checked = window.mindfulVoiceEnabled;
    window.dispatchEvent(new CustomEvent('mindful:voice-preference-changed', { detail: { enabled: window.mindfulVoiceEnabled } }));
    recommendation?.addEventListener('change', () => {
      const original = document.querySelector('#recommendation-use-journal');
      if (original) { original.checked = recommendation.checked; original.dispatchEvent(new Event('change', { bubbles: true })); }
      let saved = false;
      try { const state = JSON.parse(localStorage.getItem(preferenceKey) || '{}'); state.useJournalContext = recommendation.checked; localStorage.setItem(preferenceKey, JSON.stringify(state)); saved = true; } catch (_) {}
      document.querySelector('#settings-preferences-status').textContent = saved ? 'Privacy preference saved on this device.' : 'Preference changed for this session, but browser storage is unavailable.';
    });
    voice?.addEventListener('change', () => {
      window.mindfulVoiceEnabled = voice.checked;
      let saved = false;
      try { localStorage.setItem(`${prefix}voice-features-enabled-v1`, String(voice.checked)); saved = true; } catch (_) {}
      window.dispatchEvent(new CustomEvent('mindful:voice-preference-changed', { detail: { enabled: voice.checked } }));
      document.querySelector('#settings-preferences-status').textContent = !saved ? 'Voice setting changed for this session, but browser storage is unavailable.' : voice.checked ? 'Voice controls enabled. Separate consent is still required each time.' : 'Voice controls disabled on this device.';
    });
    document.querySelector('#profile-settings-form')?.addEventListener('submit', async (event) => {
      event.preventDefault();
      const status = document.querySelector('#profile-settings-status'); const button = event.currentTarget.querySelector('[type="submit"]');
      button.disabled = true; status.textContent = 'Saving…';
      try {
        const updated = await request('/users/me', { method: 'PATCH', body: JSON.stringify({ display_name: name.value.trim() }) });
        setCurrentUser(updated); if (name) name.value = updated.display_name;
        window.dispatchEvent(new Event('mindful:profile-updated'));
        status.textContent = 'Display name updated.';
      } catch (error) { status.textContent = error.message; }
      finally { button.disabled = false; }
    });
    document.querySelector('#password-settings-form')?.addEventListener('submit', async (event) => {
      event.preventDefault();
      const form = event.currentTarget; const status = document.querySelector('#password-settings-status'); const button = form.querySelector('[type="submit"]');
      const values = new FormData(form); const next = String(values.get('new_password')); const confirm = document.querySelector('#settings-confirm-password').value;
      if (next !== confirm) { status.textContent = 'The new passwords do not match.'; return; }
      button.disabled = true; status.textContent = 'Updating password…';
      try { await request('/auth/change-password', { method: 'POST', body: JSON.stringify({ current_password: String(values.get('current_password')), new_password: next }) }); form.reset(); status.textContent = 'Password updated. Other active sessions have been signed out.'; }
      catch (error) { status.textContent = error.message; }
      finally { button.disabled = false; }
    });
  }

  function loadScript(src) {
    return new Promise((resolve, reject) => {
      const script = document.createElement('script');
      script.src = src;
      script.async = false;
      script.onload = resolve;
      script.onerror = () => reject(new Error('Mindful could not load the workspace. Reload the page to try again.'));
      document.body.append(script);
    });
  }

  async function validateSession() {
    if (sessionCheckRunning) return;
    sessionCheckRunning = true;
    try {
      const user = await request('/users/me');
      if (!appLoaded) await loadProtectedExperience(user);
      else if (window.mindfulUser?.id !== user.id || window.mindfulUser?.role !== user.role) window.location.reload();
      showMessage('');
    } catch (error) {
      if (error.message === 'Authentication is required or the session has expired.') {
        if (appLoaded) window.location.reload();
        else showMessage('Sign in to open your private Mindful workspace.');
      } else {
        showMessage(error.message, true);
      }
    } finally {
      sessionCheckRunning = false;
    }
  }

  async function signIn(email, password) {
    let session;
    try {
      session = await request('/auth/login', { method: 'POST', body: JSON.stringify({ email, password }) });
    } catch (error) {
      if (error.message === 'Authentication is required or the session has expired.') {
        throw new Error('Email or password is incorrect. Check your credentials and try again.');
      }
      throw error;
    }
    if (!session?.user?.id || !['user', 'admin'].includes(session.user.role)) throw new Error('The sign-in service returned an invalid account response.');
    await loadProtectedExperience(session.user);
  }

  document.querySelector('#show-login')?.addEventListener('click', () => {
    document.querySelector('#login-form').hidden = false;
    document.querySelector('#register-form').hidden = true;
    document.querySelector('#show-login').setAttribute('aria-selected', 'true');
    document.querySelector('#show-register').setAttribute('aria-selected', 'false');
    showMessage('');
    document.querySelector('#login-password')?.focus();
  });

  document.querySelector('#show-register')?.addEventListener('click', () => {
    document.querySelector('#login-form').hidden = true;
    document.querySelector('#register-form').hidden = false;
    document.querySelector('#show-login').setAttribute('aria-selected', 'false');
    document.querySelector('#show-register').setAttribute('aria-selected', 'true');
    showMessage('');
    document.querySelector('#register-name')?.focus();
  });

  document.querySelector('#login-form')?.addEventListener('submit', async (event) => {
    event.preventDefault();
    const form = event.currentTarget;
    const button = form.querySelector('[type="submit"]');
    button.disabled = true;
    showMessage('Signing in…');
    try {
      const values = new FormData(form);
      await signIn(String(values.get('email')).trim(), String(values.get('password')));
    } catch (error) {
      showMessage(error.message, true);
    } finally {
      button.disabled = false;
    }
  });

  document.querySelector('#register-form')?.addEventListener('submit', async (event) => {
    event.preventDefault();
    const form = event.currentTarget;
    const button = form.querySelector('[type="submit"]');
    button.disabled = true;
    showMessage('Creating your account…');
    try {
      const values = new FormData(form);
      const registration = { display_name: String(values.get('display_name')).trim(), email: String(values.get('email')).trim(), password: String(values.get('password')) };
      await request('/auth/register', { method: 'POST', body: JSON.stringify(registration) });
      await signIn(registration.email, registration.password);
    } catch (error) {
      showMessage(error.message, true);
    } finally {
      button.disabled = false;
    }
  });

  async function logout() {
    showMessage('Signing out…');
    try {
      await request('/auth/logout', { method: 'POST' });
      window.location.replace(window.location.pathname);
    } catch (error) {
      if (error.message === 'Authentication is required or the session has expired.') window.location.replace(window.location.pathname);
      else showMessage(error.message, true);
    }
  }

  function downloadBlob(blob, name) {
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement('a'); anchor.href = url; anchor.download = name; anchor.click();
    window.setTimeout(() => URL.revokeObjectURL(url), 1500);
  }

  document.querySelector('#export-server-data')?.addEventListener('click', async (event) => {
    const button = event.currentTarget; const status = document.querySelector('#privacy-action-status');
    const previousLabel = button.textContent;
    button.disabled = true;
    button.textContent = 'Preparing export…';
    try { const blob = await request('/users/me/export', { responseType: 'blob' }); downloadBlob(blob, 'mindful-account-export.zip'); status.textContent = 'Your server account export was downloaded.'; }
    catch (error) { status.textContent = error.message || 'The server export could not be created.'; }
    finally { button.disabled = false; button.textContent = previousLabel; }
  });

  document.querySelector('#export-browser-data')?.addEventListener('click', () => {
    const status = document.querySelector('#privacy-action-status'); const id = window.mindfulUser?.id;
    if (!id) { status.textContent = 'Sign in again to export this browser’s saved data.'; return; }
    const prefix = `mindful:${id}:`; const data = {};
    for (let i = 0; i < localStorage.length; i += 1) { const key = localStorage.key(i); if (key?.startsWith(prefix)) data[key.slice(prefix.length)] = localStorage.getItem(key); }
    downloadBlob(new Blob([JSON.stringify({ account_id: id, exported_at: new Date().toISOString(), browser_saved_data: data }, null, 2)], { type: 'application/json' }), 'mindful-browser-data.json');
    status.textContent = 'Your browser-saved Mindful data was downloaded as JSON.';
  });

  document.querySelector('#delete-account')?.addEventListener('click', async (event) => {
    const button = event.currentTarget; const status = document.querySelector('#privacy-action-status');
    if (!window.confirm('Permanently delete your Mindful account and server data? This cannot be undone. Export any browser-only data first.')) return;
    const password = window.prompt('Enter your password to confirm account deletion.');
    if (password === null) return;
    if (!password) { status.textContent = 'Account deletion was not confirmed.'; return; }
    button.disabled = true;
    const id = window.mindfulUser?.id;
    try {
      await request('/users/me', { method: 'DELETE', body: JSON.stringify({ password, confirm: true }) });
      const prefix = `mindful:${id}:`;
      for (const key of Object.keys(localStorage)) if (key.startsWith(prefix)) localStorage.removeItem(key);
      try { indexedDB.deleteDatabase(`mindful-local-voices-${id}`); } catch (_) { /* Older optional local data store may not exist. */ }
      status.textContent = 'Your account and associated server data were deleted.';
      window.setTimeout(() => window.location.replace(window.location.pathname), 700);
    } catch (error) { status.textContent = error.message || 'Account deletion could not be completed.'; button.disabled = false; }
  });

  document.addEventListener('click', (event) => {
    if (event.target.closest('.auth-logout')) logout();
  });
  window.addEventListener('mindful:session-expired', () => window.location.replace(window.location.pathname));

  window.MindfulAuth = Object.freeze({ request, logout, get apiBase() { return apiBase; }, setCurrentUser });
  validateSession();
  window.setInterval(validateSession, 30000);
  document.addEventListener('visibilitychange', () => { if (!document.hidden) validateSession(); });
})();
