(() => {
  const $ = (selector, root = document) => root.querySelector(selector);
  const $$ = (selector, root = document) => [...root.querySelectorAll(selector)];
  const labels = ['calm', 'happy', 'sad', 'angry', 'anxious', 'neutral'];

  let adminSamples = [];
  let activeStream = null;
  let activeRecorder = null;
  let activeButton = null;
  let activeStopButton = null;
  let activeStatus = null;
  let captureStartedAt = 0;
  let recordingTimer = null;
  let pendingSample = null;
  let pendingSampleDuration = 0;
  let previewUrl = null;
  let pendingLiveRecording = null;
  let livePreviewUrl = null;
  let savingSample = false;
  let captureGeneration = 0;
  let acquiringAudio = false;
  let processingAudio = false;

  const requiredMessage = 'The private voice dataset service is unavailable. Check that Mindful is connected to the API.';
  const setText = (selector, value) => { const element = $(selector); if (element) element.textContent = value; };
  const stopTracks = (stream) => stream?.getTracks().forEach((track) => track.stop());

  const allSamples = async () => {
    if (window.mindfulUser?.role !== 'admin') return [];
    adminSamples = await window.MindfulAuth.request('/admin/voice-samples');
    return adminSamples;
  };

  function discardLiveRecording(updateStatus = false) {
    pendingLiveRecording = null;
    const audio = $('#live-recording-preview');
    if (audio) { audio.pause(); audio.removeAttribute('src'); audio.load?.(); }
    if (livePreviewUrl) URL.revokeObjectURL(livePreviewUrl);
    livePreviewUrl = null;
    const review = $('#live-recording-review'); if (review) review.hidden = true;
    const consent = $('#live-save-consent'); if (consent) consent.checked = false;
    const recordConsent = $('#live-record-consent'); if (recordConsent) recordConsent.checked = false;
    const recordButton = $('#live-record'); if (recordButton) recordButton.disabled = true;
    const save = $('#live-save-recording'); if (save) save.disabled = true;
    if (updateStatus) setText('#live-status', 'Recording discarded; it was not saved or uploaded.');
  }

  function discardPendingSample(updateStatus = false) {
    pendingSample = null;
    pendingSampleDuration = 0;
    const audio = $('#sample-preview');
    if (audio) { audio.pause(); audio.removeAttribute('src'); audio.load?.(); }
    if (previewUrl) URL.revokeObjectURL(previewUrl);
    previewUrl = null;
    const review = $('#sample-review'); if (review) review.hidden = true;
    const consent = $('#sample-save-consent'); if (consent) consent.checked = false;
    const recordConsent = $('#sample-record-consent'); if (recordConsent) recordConsent.checked = false;
    const recordButton = $('#record-sample'); if (recordButton) recordButton.disabled = true;
    const save = $('#save-sample'); if (save) save.disabled = true;
    if (updateStatus) setText('#admin-status', 'Recording discarded; it was not saved.');
  }

  async function featuresFrom(blob) {
    const AudioContextClass = window.AudioContext || window.webkitAudioContext;
    if (!AudioContextClass) throw new Error('Audio analysis is not supported by this browser. Try a recent version of Chrome or Edge.');
    const context = new AudioContextClass();
    let buffer;
    try {
      buffer = await context.decodeAudioData(await blob.arrayBuffer());
    } catch (_) {
      throw new Error('The recording was captured, but the browser could not decode it for comparison. Try a recent browser.');
    } finally {
      try { await context.close(); } catch (_) { /* The audio context may already be closed. */ }
    }
    if (!buffer.numberOfChannels || !buffer.length) throw new Error('No usable audio was captured. Please record a little longer.');
    const samples = buffer.getChannelData(0);
    const frameSize = Math.max(256, Math.floor(buffer.sampleRate * 0.04));
    const frames = [];
    for (let start = 0; start + frameSize <= samples.length; start += frameSize) {
      let squareSum = 0;
      let crossings = 0;
      let previous = samples[start];
      for (let index = start; index < start + frameSize; index += 1) {
        const value = samples[index];
        squareSum += value * value;
        if ((value >= 0) !== (previous >= 0)) crossings += 1;
        previous = value;
      }
      frames.push([Math.sqrt(squareSum / frameSize), crossings / frameSize]);
    }
    if (!frames.length) throw new Error('The recording is too short to compare. Please try again.');
    const means = [0, 0];
    for (const frame of frames) { means[0] += frame[0] / frames.length; means[1] += frame[1] / frames.length; }
    const variances = [0, 0];
    for (const frame of frames) {
      variances[0] += ((frame[0] - means[0]) ** 2) / frames.length;
      variances[1] += ((frame[1] - means[1]) ** 2) / frames.length;
    }
    return [means[0], Math.sqrt(variances[0]), means[1], Math.sqrt(variances[1])];
  }

  function resetRecordButton(button) {
    if (!button) return;
    button.disabled = button.id === 'record-sample' ? !$('#sample-record-consent')?.checked : (!window.mindfulVoiceEnabled || !$('#live-record-consent')?.checked);
    button.setAttribute('aria-pressed', 'false');
    button.innerHTML = button.id === 'record-sample'
      ? '<span aria-hidden="true">●</span> Start recording'
      : '<span class="mic" aria-hidden="true">●</span> Start voice recording';
    if (button.id === 'live-record') $('#recording-mic')?.classList.remove('is-recording');
  }

  function cancelCapture() {
    captureGeneration += 1;
    clearTimeout(recordingTimer);
    if (activeRecorder) {
      activeRecorder.onstop = null;
      try { if (activeRecorder.state !== 'inactive') activeRecorder.stop(); } catch (_) { /* Stream cleanup below still runs. */ }
    }
    stopTracks(activeStream);
    activeStream = null;
    activeRecorder = null;
    acquiringAudio = false;
    processingAudio = false;
    resetRecordButton(activeButton);
    if (activeStopButton) activeStopButton.disabled = true;
    activeButton = null;
    activeStopButton = null;
    activeStatus = null;
    captureStartedAt = 0;
  }

  function stopCapture() {
    if (activeRecorder?.state !== 'recording') return;
    if (activeStatus) activeStatus.textContent = 'Stopping recording… releasing the microphone.';
    try { activeRecorder.stop(); }
    catch (_) { const status = activeStatus; cancelCapture(); if (status) status.textContent = 'The recording could not be stopped cleanly. Please try again.'; }
  }

  function permissionStatus(buttonId, message) {
    setText(buttonId === 'record-sample' ? '#admin-mic-permission' : '#microphone-permission-status', message);
  }

  async function refreshPermissionStatus() {
    if (!navigator.permissions?.query) return;
    try {
      const permission = await navigator.permissions.query({ name: 'microphone' });
      if (acquiringAudio || activeRecorder) return;
      const describe = () => permission.state === 'granted'
        ? 'Microphone permission is granted. Recording still starts only when you press Start.'
        : permission.state === 'denied'
          ? 'Microphone permission is blocked. Update browser site settings if you want to record.'
          : 'Microphone permission has not been granted. It will be requested only when you press Start.';
      permissionStatus('live-record', describe());
      permissionStatus('record-sample', describe());
      permission.addEventListener?.('change', () => { permissionStatus('live-record', describe()); permissionStatus('record-sample', describe()); });
    } catch (_) { /* Permission status will be reported when the user starts a recording. */ }
  }

  function formatFileSize(bytes) {
    if (bytes < 1024) return bytes + ' B';
    if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(1) + ' KB';
    return (bytes / (1024 * 1024)).toFixed(2) + ' MB';
  }

  function formatDuration(milliseconds) {
    const seconds = Math.max(0, Math.round(milliseconds / 1000));
    return String(Math.floor(seconds / 60)).padStart(2, '0') + ':' + String(seconds % 60).padStart(2, '0');
  }

  async function capture(button, stopButton, status, onBlob) {
    if (!button || !status || activeRecorder || acquiringAudio || processingAudio) return;
    if (!navigator.mediaDevices?.getUserMedia || !window.MediaRecorder) {
      status.textContent = 'Voice recording is not supported here. Use a recent browser on localhost or HTTPS.';
      permissionStatus(button.id, 'Microphone permission was not requested because recording is unsupported in this browser.');
      return;
    }
    window.dispatchEvent(new Event('mindful:media-capture-start'));
    const generation = ++captureGeneration;
    acquiringAudio = true; activeButton = button; activeStopButton = stopButton; activeStatus = status;
    button.disabled = true; if (stopButton) stopButton.disabled = true;
    status.textContent = 'Requesting microphone permission…'; permissionStatus(button.id, 'Requesting microphone permission…');
    let stream = null;
    try {
      stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      if (generation !== captureGeneration) { stopTracks(stream); return; }
      let mediaRecorder;
      try { mediaRecorder = new window.MediaRecorder(stream); }
      catch (error) { stopTracks(stream); throw error; }
      const chunks = []; activeStream = stream; activeRecorder = mediaRecorder; captureStartedAt = Date.now();
      permissionStatus(button.id, 'Microphone permission granted for this recording.');
      mediaRecorder.ondataavailable = (event) => { if (event.data?.size) chunks.push(event.data); };
      mediaRecorder.onerror = () => {
        stopTracks(stream);
        if (generation === captureGeneration) { status.textContent = 'A recording error occurred. The microphone has been released. Please try again.'; permissionStatus(button.id, 'Microphone was available, but recording failed.'); cancelCapture(); }
      };
      mediaRecorder.onstop = async () => {
        clearTimeout(recordingTimer);
        const duration = Math.max(0, Date.now() - captureStartedAt);
        stopTracks(stream);
        if (activeStream === stream) activeStream = null;
        if (activeRecorder === mediaRecorder) activeRecorder = null;
        resetRecordButton(activeButton);
        if (activeStopButton) activeStopButton.disabled = true;
        activeStopButton = null; activeButton = null; activeStatus = null; captureStartedAt = 0;
        if (generation !== captureGeneration) return;
        const blob = new Blob(chunks, { type: mediaRecorder.mimeType || chunks[0]?.type || 'audio/webm' });
        if (!blob.size) { status.textContent = 'No audio was captured. Please try again.'; permissionStatus(button.id, 'Permission was granted, but no recording data was captured.'); return; }
        acquiringAudio = false; processingAudio = true;
        status.textContent = 'Recording ready · ' + formatDuration(duration) + ' · ' + formatFileSize(blob.size) + '. Microphone released.';
        try { await onBlob(blob, duration); }
        catch (error) { status.textContent = error?.message || 'Could not process this recording. Please try again.'; }
        finally { processingAudio = false; activeButton = null; activeStatus = null; }
      };
      mediaRecorder.start(); acquiringAudio = false;
      button.setAttribute('aria-pressed', 'true'); if (stopButton) stopButton.disabled = false;
      if (button.id === 'live-record') $('#recording-mic')?.classList.add('is-recording');
      status.textContent = 'Recording… select Stop recording or wait up to 10 seconds.';
      recordingTimer = window.setTimeout(stopCapture, 10000);
    } catch (error) {
      stopTracks(stream); if (activeStream === stream) activeStream = null; activeRecorder = null;
      if (generation === captureGeneration) {
        status.textContent = error?.name === 'NotAllowedError' || error?.name === 'SecurityError'
          ? 'Microphone permission was denied or blocked. You can allow access in browser settings and try again.'
          : error?.name === 'NotFoundError' ? 'No microphone was found on this device.'
            : error?.name === 'NotReadableError' ? 'The microphone is busy in another app. Close it and try again.'
              : error?.name === 'AbortError' ? 'Microphone startup was interrupted. Please try again.'
                : 'Could not start recording. Check microphone access and browser support.';
        permissionStatus(button.id, error?.name === 'NotAllowedError' || error?.name === 'SecurityError'
          ? 'Microphone permission denied or blocked.'
          : stream ? 'Microphone permission was granted, but the recorder could not start.' : 'Microphone permission was not granted for this attempt.');
      }
      acquiringAudio = false; resetRecordButton(button); if (stopButton) stopButton.disabled = true;
      if (activeButton === button) activeButton = null; if (activeStopButton === stopButton) activeStopButton = null; activeStatus = null;
    }
  }

  window.addEventListener('mindful:speech-input-start', () => {
    if (activeRecorder || acquiringAudio) cancelCapture();
  });

  function makeOptionSelect(value, sampleId) {
    const select = document.createElement('select');
    select.className = 'sample-label-edit';
    select.dataset.sampleId = String(sampleId);
    select.setAttribute('aria-label', `Change ${value} recording label`);
    for (const label of labels) {
      const option = document.createElement('option');
      option.value = label;
      option.textContent = label;
      option.selected = value === label;
      select.append(option);
    }
    return select;
  }

  async function renderLibrary() {
    const library = $('#voice-library');
    if (!library) return;
    library.replaceChildren();
    if (window.mindfulUser?.role !== 'admin') return;
    let samples;
    try { samples = await allSamples(); }
    catch (error) {
      const notice = document.createElement('p'); notice.className = 'empty-library'; notice.textContent = error.message || requiredMessage; library.append(notice); return;
    }
    const summary = await window.MindfulAuth.request('/admin/voice-samples/summary').catch(() => null);
    const count = $('#voice-dataset-summary');
    if (count) count.textContent = summary ? `${summary.total_samples} saved sample${summary.total_samples === 1 ? '' : 's'} · ` + labels.map((label) => `${label}: ${summary.samples_per_class[label] || 0}`).join(' · ') : 'Dataset counts are unavailable.';
    if (!samples.length) {
      const empty = document.createElement('p');
      empty.className = 'empty-library';
      empty.textContent = 'No recordings yet. Add a few labeled examples to get started.';
      library.append(empty);
      return;
    }
    for (const sample of samples) {
      const row = document.createElement('div');
      row.className = 'voice-row';
      row.dataset.sampleId = String(sample.id);
      const title = document.createElement('div');
      title.className = 'sample-meta';
      const name = document.createElement('strong');
      name.textContent = labels.includes(sample.label) ? `${sample.label[0].toUpperCase()}${sample.label.slice(1)}` : 'Unlabeled recording';
      const created = document.createElement('small');
      created.textContent = sample.created_at ? new Date(sample.created_at).toLocaleString() : 'Date unavailable';
      title.append(name, created);
      row.append(title, makeOptionSelect(sample.label, sample.id));
      const play = document.createElement('button');
      play.type = 'button'; play.className = 'button secondary'; play.dataset.action = 'play'; play.textContent = 'Play';
      play.setAttribute('aria-label', 'Play ' + name.textContent.toLowerCase() + ' voice sample');
      const remove = document.createElement('button');
      remove.type = 'button'; remove.className = 'button delete-sample'; remove.dataset.action = 'delete'; remove.textContent = 'Delete';
      remove.setAttribute('aria-label', 'Delete ' + name.textContent.toLowerCase() + ' voice sample');
      row.append(play, remove);
      library.append(row);
    }
  }

  function estimateEmotion(current, samples) {
    if (!Array.isArray(current) || current.length !== 4 || current.some((value) => !Number.isFinite(value))) {
      return { error: 'The audio features could not be measured. Try recording again.' };
    }
    const groups = new Map();
    for (const sample of samples) {
      if (!labels.includes(sample.label) || !Array.isArray(sample.features) || sample.features.length !== 4 || sample.features.some((value) => !Number.isFinite(value))) continue;
      if (!groups.has(sample.label)) groups.set(sample.label, []);
      groups.get(sample.label).push(sample.features);
    }
    const usable = [...groups.entries()].filter(([, items]) => items.length >= 2);
    if (usable.length < 2) return { error: 'Not enough reference data yet. Admin needs at least 2 examples for each of 2 emotion labels.' };
    const scales = [0.025, 0.02, 0.06, 0.04];
    const distances = usable.map(([label, items]) => {
      const center = current.map((_, index) => items.reduce((sum, feature) => sum + feature[index], 0) / items.length);
      const distance = Math.sqrt(center.reduce((sum, value, index) => sum + ((value - current[index]) / scales[index]) ** 2, 0));
      return { label, distance };
    }).sort((left, right) => left.distance - right.distance);
    return { label: distances[0].label };
  }

  function showVoiceResult(result) {
    const panel = $('#emotion-dashboard');
    if (!panel) return;
    panel.replaceChildren();
    const label = document.createElement('div');
    label.className = 'emotion-label';
    const eyebrow = document.createElement('span');
    eyebrow.className = 'card-kicker';
    eyebrow.textContent = result.error ? 'VOICE COMPARISON' : 'CLOSEST SAMPLE LABEL';
    const value = document.createElement('strong');
    value.textContent = result.label ? `${result.label[0].toUpperCase()}${result.label.slice(1)}` : 'Not available';
    label.append(eyebrow, value);
    const note = document.createElement('p');
    note.textContent = result.error || 'This is a rough acoustic similarity to local examples, not a reliable reading of emotion.';
    panel.append(label, note);
    panel.hidden = false;
  }

  function wireLibrary() {
    const library = $('#voice-library');
    if (!library) return;
    library.addEventListener('change', async (event) => {
      const select = event.target.closest('.sample-label-edit');
      if (!select) return;
      const status = $('#admin-status');
      try {
        const sample = adminSamples.find((entry) => String(entry.id) === select.dataset.sampleId);
        if (!sample || !labels.includes(select.value)) throw new Error('That recording or label is no longer available.');
        await window.MindfulAuth.request(`/admin/voice-samples/${encodeURIComponent(sample.id)}`, { method: 'PATCH', body: JSON.stringify({ label: select.value }) });
        if (status) status.textContent = 'Recording label updated.';
        await renderLibrary();
      } catch (error) { if (status) status.textContent = error.message || 'Could not update the recording label.'; }
    });
    library.addEventListener('click', async (event) => {
      const button = event.target.closest('button[data-action]');
      if (!button) return;
      const row = button.closest('.voice-row');
      const sampleId = row?.dataset.sampleId;
      const status = $('#admin-status');
      try {
        const sample = adminSamples.find((entry) => String(entry.id) === sampleId);
        if (!sample) throw new Error('That recording is no longer available.');
        if (button.dataset.action === 'play') {
          const recording = await window.MindfulAuth.request(`/admin/voice-samples/${encodeURIComponent(sample.id)}/audio`, { responseType: 'blob' });
          const url = URL.createObjectURL(recording);
          const audio = new Audio(url);
          const release = () => URL.revokeObjectURL(url);
          audio.addEventListener('ended', release, { once: true });
          audio.addEventListener('error', release, { once: true });
          try { await audio.play(); }
          catch (_) { release(); throw new Error('This recording could not be played by the browser.'); }
        } else if (button.dataset.action === 'delete') {
          if (!window.confirm('Delete this voice recording from Mindful’s private dataset? This cannot be undone.')) return;
          await window.MindfulAuth.request(`/admin/voice-samples/${encodeURIComponent(sample.id)}?confirm=true`, { method: 'DELETE' });
          await renderLibrary();
          if (status) status.textContent = 'Recording deleted.';
        }
      } catch (error) { if (status) status.textContent = error.message || 'Could not complete that library action.'; }
    });
  }

  function setCaptureMode(mode) {
    const isCamera = mode === 'camera';
    const cameraPanel = $('#camera-mode-panel');
    const voicePanel = $('#voice-mode-panel');
    const cameraMode = $('#camera-mode');
    const voiceMode = $('#voice-mode');
    if (cameraPanel) cameraPanel.hidden = !isCamera;
    if (voicePanel) voicePanel.hidden = isCamera;
    if (cameraMode) { cameraMode.classList.toggle('selected', isCamera); cameraMode.setAttribute('aria-pressed', String(isCamera)); }
    if (voiceMode) { voiceMode.classList.toggle('selected', !isCamera); voiceMode.setAttribute('aria-pressed', String(!isCamera)); }
    if (isCamera) {
      if (activeButton?.id === 'live-record' && (activeRecorder || acquiringAudio)) cancelCapture();
      discardLiveRecording(false);
    }
    if (!isCamera) window.dispatchEvent(new Event('mindful:stop-camera'));
    setText('#live-status', isCamera ? 'Camera preview only. It does not analyze your face.' : 'Record up to 10 seconds. Microphone access is optional.');
  }

  function start() {
    const login = $('#login-gate');
    const admin = $('#admin-panel');
    const userTools = $('#user-tools');
    const shell = $('.shell');
    const userHeader = $('.user-header');
    const reflectionDetails = $('#reflection-details');
    const resultPanel = $('#result');
    const supportPanel = $('.user-support');
    const footer = $('.user-footer');
    const sidebarNav = $('#primary-navigation');
    const navToggle = $('#nav-toggle');
    const navGroups = $$('[data-nav-role]', sidebarNav || document);
    const navLinks = $$('.nav-item', sidebarNav || document);

    function closeNavigation(restoreFocus = false) {
      const wasOpen = sidebar?.classList.contains('nav-open');
      sidebar?.classList.remove('nav-open');
      navToggle?.setAttribute('aria-expanded', 'false');
      if (restoreFocus && wasOpen && window.matchMedia('(max-width: 850px)').matches) navToggle?.focus();
    }

    function updateActiveNavigation(view) {
      const group = navGroups.find((item) => item.dataset.navRole === view);
      const links = group ? $$('.nav-item', group) : [];
      const current = window.location.hash;
      const active = links.find((link) => link.getAttribute('href') === current) || links[0];
      navLinks.forEach((link) => {
        const isActive = link === active;
        link.classList.toggle('active', isActive);
        if (isActive) link.setAttribute('aria-current', 'page');
        else link.removeAttribute('aria-current');
      });
    }
    function syncAdminSection() {
      if (!admin || admin.hidden) return;
      const adminLinks = $$('.nav-item', navGroups.find((item) => item.dataset.navRole === 'admin') || document);
      const match = adminLinks.find((link) => link.hash === window.location.hash);
      const target = match ? document.getElementById(match.hash.slice(1)) : $('#admin-dashboard');
      let panel = target;
      while (panel && panel.parentElement !== admin) panel = panel.parentElement;
      const activeId = panel?.id || 'admin-dashboard';
      admin.dataset.activeSection = activeId;
      adminLinks.forEach((link) => {
        const active = link === match || (!match && link.hash === '#admin-dashboard');
        link.classList.toggle('active', active);
        if (active) link.setAttribute('aria-current', 'page');
        else link.removeAttribute('aria-current');
      });
    }
    const sidebar = $('.sidebar');
    const workspaceTitle = $('#workspace-title');
    const workspaceStatus = $('#workspace-status');

    function setView(view) {
      if (view !== 'admin') cancelCapture();
      if (view !== 'admin') discardPendingSample(false);
      if (view !== 'user') discardLiveRecording(false);
      if (view !== 'user') window.dispatchEvent(new Event('mindful:stop-camera'));
      const showUser = view === 'user';
      if (login) login.hidden = view !== 'login';
      if (admin) admin.hidden = view !== 'admin';
      if (userTools) userTools.hidden = !showUser;
      if (userHeader) userHeader.hidden = !showUser;
      if (reflectionDetails) { reflectionDetails.hidden = !showUser; if (!showUser) reflectionDetails.open = false; }
      if (supportPanel) supportPanel.hidden = !showUser;
      if (footer) footer.hidden = !showUser;
      if (!showUser && resultPanel) resultPanel.hidden = true;
      shell?.classList.toggle('auth-mode', view === 'login');
      if (sidebar) sidebar.hidden = view === 'login';
      if (workspaceTitle) workspaceTitle.textContent = showUser ? 'User workspace' : view === 'admin' ? 'Admin workspace' : 'Mindful';
      if (workspaceStatus) workspaceStatus.textContent = window.mindfulUser ? `${window.mindfulUser.role} · ${window.mindfulUser.email}` : 'Signed out';
      navGroups.forEach((group) => { group.hidden = group.dataset.navRole !== view; });
      if (sidebarNav) sidebarNav.hidden = view === 'login';
      closeNavigation();
      updateActiveNavigation(showUser ? 'user' : view);
      syncAdminSection();
      if (showUser) {
        setCaptureMode('camera');
        window.dispatchEvent(new Event('mindful:view-user'));
      } else window.dispatchEvent(new Event('mindful:view-hidden'));
      const heading = showUser ? $('#greeting') : view === 'admin' ? $('#admin-dashboard h1') : $('#login-gate h1');
      heading?.focus({ preventScroll: true });
      window.scrollTo?.({ top: 0, behavior: window.matchMedia('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth' });
    }

    navToggle?.addEventListener('click', () => {
      const isOpen = sidebar?.classList.toggle('nav-open') || false;
      navToggle.setAttribute('aria-expanded', String(isOpen));
    });
    sidebarNav?.addEventListener('click', (event) => {
      if (event.target.closest('.nav-item')) closeNavigation(true);
    });
    window.addEventListener('hashchange', () => {
      const activeRole = navGroups.find((group) => !group.hidden)?.dataset.navRole;
      if (activeRole) updateActiveNavigation(activeRole);
      syncAdminSection();
    });
    document.addEventListener('keydown', (event) => {
      if (event.key === 'Escape' && sidebar?.classList.contains('nav-open')) closeNavigation(true);
    });
    const initialView = window.mindfulUser?.role === 'admin' ? 'admin' : 'user';
    setView(initialView);
    refreshPermissionStatus();
    if (initialView === 'admin') wireLibrary();

    $('#camera-mode')?.addEventListener('click', () => setCaptureMode('camera'));
    $('#voice-mode')?.addEventListener('click', () => setCaptureMode('voice'));

    $('#record-sample')?.addEventListener('click', (event) => {
      if (!$('#sample-record-consent')?.checked) { setText('#admin-status', 'Give recording consent before requesting microphone access.'); return; }
      const status = $('#admin-status');
      if (pendingSample && !window.confirm('Discard the current recording preview and start a new one?')) return;
      discardPendingSample(false);
      capture(event.currentTarget, $('#stop-sample'), status, async (blob, duration) => {
        pendingSample = blob;
        pendingSampleDuration = duration;
        if (previewUrl) URL.revokeObjectURL(previewUrl);
        previewUrl = URL.createObjectURL(blob);
        const audio = $('#sample-preview');
        const review = $('#sample-review');
        if (audio) audio.src = previewUrl;
        if (review) review.hidden = false;
        setText('#sample-recording-info', 'Duration ' + formatDuration(duration) + ' · ' + formatFileSize(blob.size));
        const consent = $('#sample-save-consent'); if (consent) consent.checked = false;
        const save = $('#save-sample'); if (save) save.disabled = true;
        if (status) status.textContent = 'Preview ready. Confirm consent to submit this sample to the private Mindful dataset.';
      });
    });
    $('#stop-sample')?.addEventListener('click', stopCapture);
    $('#sample-record-consent')?.addEventListener('change', (event) => { const button = $('#record-sample'); if (button) button.disabled = !event.currentTarget.checked || Boolean(activeRecorder) || acquiringAudio; });
    $('#sample-save-consent')?.addEventListener('change', (event) => { const save = $('#save-sample'); if (save) save.disabled = !event.currentTarget.checked || !pendingSample; });
    $('#save-sample')?.addEventListener('click', async () => {
      const status = $('#admin-status');
      const saveButton = $('#save-sample');
      const label = $('#sample-label')?.value;
      const recordingToSave = pendingSample;
      if (savingSample) return;
      if (!recordingToSave) { if (status) status.textContent = 'Record and review a sample before saving.'; return; }
      if (!$('#sample-save-consent')?.checked) { if (status) status.textContent = 'Please give consent before saving this recording to the private dataset.'; return; }
      if (!$('#sample-record-consent')?.checked) { if (status) status.textContent = 'Recording consent is required to save this sample.'; return; }
      if (!labels.includes(label)) { if (status) status.textContent = 'Choose a valid emotion label before saving.'; return; }
      savingSample = true;
      if (saveButton) saveButton.disabled = true;
      if (status) status.textContent = 'Saving labeled recording to the private dataset…';
      let saved = false;
      try {
        const mime = recordingToSave.type.split(';')[0].trim().toLowerCase();
        if (!['audio/webm', 'audio/ogg', 'audio/wav', 'audio/x-wav', 'audio/mpeg', 'audio/flac'].includes(mime)) throw new Error('This browser recording format is not supported for dataset storage.');
        const extension = mime.includes('webm') ? 'webm' : mime.includes('ogg') ? 'ogg' : mime.includes('wav') ? 'wav' : mime.includes('mpeg') ? 'mp3' : 'flac';
        const form = new FormData();
        form.set('label', label);
        form.set('recording_consent_given', 'true');
        form.set('consent_given', 'true');
        form.set('speaker_consent_confirmed', 'true');
        form.set('confirm_save', 'true');
        form.set('duration_ms', String(Math.max(1, Math.round(pendingSampleDuration))));
        form.set('file', recordingToSave.slice(0, recordingToSave.size, mime), `mindful-sample.${extension}`);
        await window.MindfulAuth.request('/admin/voice-samples', { method: 'POST', body: form });
        saved = true;
        pendingSample = null;
        pendingSampleDuration = 0;
        if ($('#sample-review')) $('#sample-review').hidden = true;
        const audio = $('#sample-preview');
        if (audio) { audio.pause(); audio.removeAttribute('src'); }
        if ($('#sample-save-consent')) $('#sample-save-consent').checked = false;
        if ($('#sample-record-consent')) $('#sample-record-consent').checked = false;
        if ($('#save-sample')) $('#save-sample').disabled = true;
        if (previewUrl) URL.revokeObjectURL(previewUrl);
        previewUrl = null;
        if (status) status.textContent = 'Recording saved under the selected emotion. It is private to authorized administrators.';
        try { await renderLibrary(); }
        catch (_) { if (status) status.textContent = 'Recording saved, but the library list could not refresh.'; }
      } catch (error) { if (status) status.textContent = saved ? 'Recording saved, but the library could not refresh.' : (error.message || 'Could not save this recording.'); }
      finally { savingSample = false; if (saveButton) saveButton.disabled = !pendingSample || !$('#sample-save-consent')?.checked || !$('#sample-record-consent')?.checked; }
    });
    $('#discard-sample')?.addEventListener('click', () => {
      discardPendingSample(true);
    });
    $('#export-voice-metadata')?.addEventListener('click', async (event) => {
      const button = event.currentTarget;
      const status = $('#admin-status');
      button.disabled = true;
      if (status) status.textContent = 'Preparing private dataset metadata export…';
      try {
        const file = await window.MindfulAuth.request('/admin/voice-samples/export.csv', { responseType: 'blob' });
        const url = URL.createObjectURL(file);
        const link = document.createElement('a');
        link.href = url;
        link.download = 'voice-sample-metadata.csv';
        link.click();
        URL.revokeObjectURL(url);
        if (status) status.textContent = 'Dataset metadata exported. Audio files are not included.';
      } catch (error) {
        if (status) status.textContent = error.message || 'Could not export dataset metadata.';
      } finally { button.disabled = false; }
    });
    $('#clear-library')?.addEventListener('click', async () => {
      const status = $('#admin-status');
      if (!window.confirm('Delete every voice sample in the private Mindful dataset? This cannot be undone.')) return;
      try {
        const samples = await allSamples();
        for (const sample of samples) await window.MindfulAuth.request(`/admin/voice-samples/${encodeURIComponent(sample.id)}?confirm=true`, { method: 'DELETE' });
        await renderLibrary();
        if (status) status.textContent = 'Private voice dataset cleared.';
      } catch (error) { if (status) status.textContent = error.message || 'Could not clear the private dataset.'; }
    });
    $('#live-record')?.addEventListener('click', (event) => {
      if (!$('#live-record-consent')?.checked) { setText('#live-status', 'Give recording consent before requesting microphone access.'); return; }
      if (pendingLiveRecording && !window.confirm('Discard the current recording preview and start a new one?')) return;
      discardLiveRecording(false);
      capture(event.currentTarget, $('#live-stop'), $('#live-status'), async (blob, duration) => {
        pendingLiveRecording = blob;
        if (livePreviewUrl) URL.revokeObjectURL(livePreviewUrl);
        livePreviewUrl = URL.createObjectURL(blob);
        const audio = $('#live-recording-preview'); if (audio) audio.src = livePreviewUrl;
        const review = $('#live-recording-review'); if (review) review.hidden = false;
        setText('#live-recording-info', 'Duration ' + formatDuration(duration) + ' · ' + formatFileSize(blob.size));
        const consent = $('#live-save-consent'); if (consent) consent.checked = false;
        const save = $('#live-save-recording'); if (save) save.disabled = true;
        if (!$('#analyze-voice')?.checked) {
          const resultPanel = $('#emotion-dashboard');
          if (resultPanel) { resultPanel.replaceChildren(); resultPanel.hidden = true; }
          setText('#live-status', 'Recording ready for preview. Analysis was skipped. Audio was not saved or uploaded.');
          return;
        }
        const features = await featuresFrom(blob);
        const result = estimateEmotion(features, await allSamples());
        showVoiceResult(result);
        setText('#live-status', result.error
          ? 'Voice captured. ' + result.error
          : 'Recording preview ready. It was compared with examples on this device only, and was not saved or uploaded. This experimental estimate is not a diagnosis.');
      });
    });
    $('#live-stop')?.addEventListener('click', stopCapture);
    $('#live-record-consent')?.addEventListener('change', (event) => { const button = $('#live-record'); if (button) button.disabled = !window.mindfulVoiceEnabled || !event.currentTarget.checked || Boolean(activeRecorder) || acquiringAudio; });
    const liveRecord = $('#live-record'); if (liveRecord) liveRecord.disabled = !window.mindfulVoiceEnabled || !$('#live-record-consent')?.checked;
    window.addEventListener('mindful:voice-preference-changed', (event) => {
      const button = $('#live-record');
      if (!event.detail?.enabled) {
        if (activeButton?.id === 'live-record' && (activeRecorder || acquiringAudio)) cancelCapture();
        discardLiveRecording(false);
      }
      if (button) button.disabled = !event.detail?.enabled || !$('#live-record-consent')?.checked || Boolean(activeRecorder) || acquiringAudio;
    });
    $('#live-save-consent')?.addEventListener('change', (event) => { const save = $('#live-save-recording'); if (save) save.disabled = !event.currentTarget.checked || !pendingLiveRecording; });
    $('#live-save-recording')?.addEventListener('click', () => {
      if (!pendingLiveRecording || !$('#live-save-consent')?.checked) { setText('#live-status', 'Choose the consent box before saving a copy to your device.'); return; }
      const mime = pendingLiveRecording.type || 'audio/webm';
      const extension = mime.includes('ogg') ? 'ogg' : mime.includes('mp4') ? 'm4a' : 'webm';
      const url = URL.createObjectURL(pendingLiveRecording); const anchor = document.createElement('a');
      anchor.href = url; anchor.download = 'mindful-voice-recording-' + new Date().toISOString().replace(/[:.]/g, '-') + '.' + extension;
      anchor.click(); window.setTimeout(() => URL.revokeObjectURL(url), 1000);
      setText('#live-status', 'A local download was requested. Mindful did not upload or store the audio.');
    });
    $('#live-discard-recording')?.addEventListener('click', () => discardLiveRecording(true));

    window.addEventListener('mindful:reset-checkin', () => setCaptureMode('camera'));
    window.addEventListener('pagehide', () => {
      cancelCapture();
      discardPendingSample(false);
      discardLiveRecording(false);
    });

    if (initialView === 'admin') {
      renderLibrary().catch((error) => setText('#admin-status', error.message || requiredMessage));
    }
  }

  start();
})();
