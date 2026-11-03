(() => {
  const $ = (selector, root = document) => root.querySelector(selector);
  const $$ = (selector, root = document) => [...root.querySelectorAll(selector)];

  const reflection = $('#reflection');
  const listenButton = $('#listen');
  const speechStatus = $('#speech-status');
  const wordCount = $('#word-count');
  const moodGroup = $('.moods');
  const moodSelectionStatus = $('#mood-selection-status');
  const intensity = $('#intensity');
  const intensityValue = $('#intensity-value');
  const cameraButton = $('#camera-toggle');
  const video = $('#camera-video');
  const cameraStage = $('#camera-stage');
  const liveStatus = $('#live-status');
  const helpButton = $('.help');
  const helpMessage = $('#help-message');
  const resultPanel = $('#result');
  const reflectionDetails = $('#reflection-details');
  const checkinPanel = $('#check-in-panel');
  if (reflectionDetails && checkinPanel) {
    checkinPanel.append(reflectionDetails);
    reflectionDetails.hidden = false;
  }

  // Treat the user sidebar as section navigation instead of a long page of anchors.
  const userTools = $('#user-tools');
  const userNavigation = $('#primary-navigation .nav-group[data-nav-role="user"]');
  if (userTools && userNavigation) {
    const sectionForHash = (hash) => {
      const target = hash ? document.getElementById(decodeURIComponent(hash.slice(1))) : null;
      if (target?.id === 'resources') return 'resources';
      const section = target?.closest('#user-tools > section');
      return section?.id || 'dashboard';
    };
    const showSection = () => {
      const activeId = sectionForHash(window.location.hash);
      userTools.dataset.activeSection = activeId;
      const resources = $('#resources');
      if (resources) resources.hidden = activeId !== 'resources';
      userNavigation.querySelectorAll('.nav-item').forEach((link) => {
        const selected = sectionForHash(link.hash) === activeId;
        link.classList.toggle('active', selected);
        if (selected) link.setAttribute('aria-current', 'page');
        else link.removeAttribute('aria-current');
      });
    };
    window.addEventListener('hashchange', showSection);
    showSection();
  }

  let recognition = null;
  let journalRecognition = null;
  let listening = false;
  let cameraStream = null;
  let latestReport = null;
  let savedCheckins = [];
  let currentCheckin = null;
  let historyStorageAvailable = true;
  let editingEntryId = null;
  let isSubmitting = false;
  let calendarMonth = new Date(new Date().getFullYear(), new Date().getMonth(), 1);
  let selectedHistoryDate = null;
  let historyRange = 'week';
  const storageKey = (key) => `mindful:${window.mindfulUser?.id || 'unavailable'}:${key}`;
  const HISTORY_KEY = storageKey('checkin-history-v1');
  const JOURNAL_KEY = storageKey('journal-entries-v1');
  let journalEntries = [];
  const JOURNAL_PAGE_SIZE = 50;
  let journalVisibleLimit = JOURNAL_PAGE_SIZE;
  let journalSearchTimer = null;
  let savedActivities = [];
  let editingJournalId = null;
  let journalStorageAvailable = true;

  window.addEventListener('mindful:media-capture-start', () => {
    try { recognition?.stop(); } catch (_) { /* The browser may have stopped it already. */ }
    if (journalRecognition) { try { journalRecognition.stop(); } catch (_) { /* The browser may have stopped it already. */ } }
  });
  window.addEventListener('mindful:voice-preference-changed', (event) => {
    if (event.detail?.enabled) {
      const SpeechRecognitionClass = window.SpeechRecognition || window.webkitSpeechRecognition;
      if (listenButton) listenButton.disabled = !SpeechRecognitionClass;
      const journalVoiceButton = $('#journal-voice'); if (journalVoiceButton) journalVoiceButton.disabled = !SpeechRecognitionClass;
      return;
    }
    try { recognition?.stop(); } catch (_) {}
    try { journalRecognition?.stop(); } catch (_) {}
    if (listenButton) listenButton.disabled = true;
    const journalVoiceButton = $('#journal-voice'); if (journalVoiceButton) { journalVoiceButton.disabled = true; journalVoiceButton.setAttribute('aria-pressed', 'false'); }
    if (listenButton) listenButton.setAttribute('aria-pressed', 'false');
    if (speechStatus) speechStatus.textContent = 'Voice input is disabled in Settings. You can continue typing.';
  });

  const dailyMessages = [
    'You deserve the same kindness you offer others.',
    'A small pause can be a meaningful beginning.',
    'You can meet this moment one breath at a time.',
    'Rest is a valid part of moving forward.',
    'You do not need to have everything figured out today.',
    'Notice what you need, then take one gentle step.',
    'Your pace is allowed to be your own.'
  ];

  const RECOMMENDATION_KEY = storageKey('recommendation-preferences-v1');
  const recommendationTitles = {
    meditation: 'Short meditation', gratitude: 'Gratitude practice', 'daily-reflection': 'Daily reflection',
    'mindful-break': 'Short mindful break', relaxation: 'Relaxation exercise', 'guided-breathing': 'Guided breathing',
    'box-breathing': 'Box breathing', 'trusted-support': 'Reach out to someone you trust'
  };
  const recommendationReasons = {
    Calm: [['meditation', 'You reported feeling calm; a quiet moment can help you notice what is supporting you.'], ['gratitude', 'You reported feeling calm; noticing something you appreciate may fit this moment.'], ['mindful-break', 'A brief pause is an easy way to stay present with how you feel.']],
    Okay: [['daily-reflection', 'You reported feeling okay; a short reflection can help you notice what is working for you today.'], ['mindful-break', 'A small pause can make room for a steady, manageable routine.'], ['gratitude', 'You reported feeling okay; noticing one meaningful moment may be a useful reflection.']],
    Low: [['mindful-break', 'You reported feeling low; a brief, low effort pause may feel manageable.'], ['relaxation', 'You reported feeling low; a gentle sensory reset is one small option.'], ['trusted-support', 'If it would help, consider telling someone you trust how you are doing.']],
    Anxious: [['guided-breathing', 'You reported feeling anxious; a gentle breathing rhythm is available if it feels comfortable.'], ['mindful-break', 'You reported feeling anxious; noticing a few things around you can offer a simple grounding pause.'], ['box-breathing', 'You reported feeling anxious; you could try an optional paced breath. Skip any pauses that do not feel comfortable.']],
    Overwhelmed: [['relaxation', 'You reported feeling overwhelmed; a short, low demand relaxation pause may be easier to start.'], ['mindful-break', 'You reported feeling overwhelmed; try noticing one thing at a time before choosing a next step.'], ['daily-reflection', 'You reported feeling overwhelmed; a brief reflection can help name one manageable next step.']],
    'Not sure': [['daily-reflection', 'You reported not being sure; a gentle prompt can help you notice what is present without needing a label.'], ['mindful-break', 'You reported not being sure; taking a moment to notice your surroundings is another option.'], ['gratitude', 'You reported not being sure; you could reflect on one small thing that mattered today.']]
  };
  let recommendationState = { dismissed: {}, recent: [], signature: '', current: [] };
  try {
    const stored = JSON.parse(window.localStorage.getItem(RECOMMENDATION_KEY) || '{}');
    recommendationState = { dismissed: stored.dismissed || {}, recent: Array.isArray(stored.recent) ? stored.recent : [], signature: '', current: [] };
  } catch (_) {}

  function persistRecommendationState() {
    try { window.localStorage.setItem(RECOMMENDATION_KEY, JSON.stringify(recommendationState)); } catch (_) { /* Suggestions remain usable without saved preferences. */ }
  }

  function simpleTextHash(text) {
    let hash = 2166136261;
    for (let index = 0; index < text.length; index += 1) { hash ^= text.charCodeAt(index); hash = Math.imul(hash, 16777619); }
    return (hash >>> 0).toString(36);
  }

  function recommendationContext() {
    if (!$('#recommendation-use-journal')?.checked) return { text: '', label: '' };
    const journal = journalEntries.slice().sort((a, b) => Date.parse(b.date) - Date.parse(a.date))[0];
    const checkin = savedCheckins.find((entry) => entry.reflection?.trim());
    const journalTime = journal ? Date.parse(journal.updatedAt || journal.date) : 0;
    const checkinTime = checkin ? Date.parse(checkin.updatedAt || checkin.createdAt) : 0;
    const text = journalTime >= checkinTime ? journal?.body || '' : checkin?.reflection || '';
    const lower = text.toLocaleLowerCase();
    const topic = /\b(grateful|gratitude|thankful|appreciat)\w*/.test(lower) ? 'gratitude'
      : /\b(rest|tired|sleep|exhaust)\w*/.test(lower) ? 'rest'
        : /\b(work|task|deadline|busy|too much)\b/.test(lower) ? 'pause' : '';
    return { text, label: topic };
  }

  function recommendationCandidates(mood, intensity, context) {
    let choices = (recommendationReasons[mood] || [['mindful-break', 'A short pause can be a gentle place to begin.'], ['daily-reflection', 'A prompt can help you notice what might feel useful.'], ['gratitude', 'You could pause to notice one small thing that matters to you.']]).map(([id, reason]) => ({ id, title: recommendationTitles[id], reason }));
    if (Number.isFinite(intensity) && intensity >= 8) {
      choices = [{ id: 'mindful-break', title: recommendationTitles['mindful-break'], reason: `You rated this feeling ${intensity} out of 10. A short, simple pause may feel more manageable, if useful.` }, ...choices.filter((item) => item.id !== 'mindful-break')];
    } else if (Number.isFinite(intensity) && intensity <= 3) {
      choices = choices.map((item) => ({ ...item, reason: `${item.reason} You rated this feeling ${intensity} out of 10, so keep it light and optional.` }));
    }
    if (context.label === 'gratitude') choices.unshift({ id: 'gratitude', title: recommendationTitles.gratitude, reason: 'You chose to include saved reflections; a gratitude prompt may connect with that context.' });
    if (context.label === 'rest') choices.unshift({ id: 'relaxation', title: recommendationTitles.relaxation, reason: 'You chose to include saved reflections; a gentle rest themed pause may fit that context.' });
    if (context.label === 'pause') choices.unshift({ id: 'mindful-break', title: recommendationTitles['mindful-break'], reason: 'You chose to include saved reflections; a brief pause may fit that context.' });
    return choices.filter((item, index) => choices.findIndex((other) => other.id === item.id) === index);
  }

  function renderRecommendations(ephemeralEntry = currentCheckin) {
    const list = $('#recommendation-list'); if (!list) return;
    const current = ephemeralEntry || savedCheckins[0] || null;
    const mood = current?.mood && current.mood !== 'Not shared' ? current.mood : '';
    const intensity = current ? Number(current.intensity) : NaN;
    const context = recommendationContext();
    const basis = $('#recommendation-basis');
    if (basis) basis.textContent = mood
      ? `Based on your latest self-reported check-in: ${mood}${Number.isFinite(intensity) ? ` · intensity ${intensity}/10` : ''}. This describes one moment.`
      : 'No saved self-reported check-in to use yet. Here are a few general, optional ideas.';
    const contextNote = $('#recommendation-context-note');
    if (contextNote) contextNote.textContent = $('#recommendation-use-journal')?.checked
      ? context.text ? 'Saved reflection context is on for this view and is processed only in this browser.' : 'Reflection context is on, but there is no saved reflection to use yet.'
      : 'Reflection context is off. Turn it on only if you want saved writing to inform suggestions.';
    const sourceId = current?.id || current?.createdAt || 'no-checkin';
    const signature = `${sourceId}|${mood}|${intensity}|${context.label}|${$('#recommendation-use-journal')?.checked ? simpleTextHash(context.text) : 'off'}`;
    const now = Date.now();
    Object.keys(recommendationState.dismissed).forEach((id) => { if (now - recommendationState.dismissed[id] > 86400000) delete recommendationState.dismissed[id]; });
    if (recommendationState.signature !== signature) {
      const candidates = recommendationCandidates(mood, intensity, context).filter((item) => !recommendationState.dismissed[item.id]);
      const recent = recommendationState.recent.slice(0, 3);
      const novel = candidates.filter((item) => !recent.includes(item.id));
      const chosen = (novel.length ? novel : candidates).slice(0, 3);
      recommendationState.signature = signature;
      recommendationState.current = chosen;
      recommendationState.recent = [...chosen.map((item) => item.id), ...recommendationState.recent].filter((id, index, all) => all.indexOf(id) === index).slice(0, 8);
      persistRecommendationState();
    }
    list.replaceChildren();
    recommendationState.current.forEach((item) => {
      const card = document.createElement('article'); card.className = 'recommendation-item';
      const title = document.createElement('h3'); title.textContent = item.title;
      const reason = document.createElement('p'); reason.textContent = item.reason;
      const controls = document.createElement('div'); controls.className = 'recommendation-item-actions';
      const action = document.createElement(item.id === 'trusted-support' ? 'a' : 'button');
      if (item.id === 'trusted-support') { action.href = '#resources'; action.className = 'button secondary'; action.textContent = 'View support resources'; }
      else { action.type = 'button'; action.className = 'button secondary'; action.dataset.recommendActivity = item.id; action.textContent = 'Explore activity'; }
      const dismiss = document.createElement('button'); dismiss.type = 'button'; dismiss.className = 'recommendation-dismiss'; dismiss.dataset.dismissRecommendation = item.id; dismiss.textContent = 'Dismiss'; dismiss.setAttribute('aria-label', `Dismiss ${item.title} suggestion`);
      controls.append(action, dismiss); card.append(title, reason, controls); list.append(card);
    });
    const noResults = $('#recommendation-empty'); if (noResults) noResults.hidden = recommendationState.current.length > 0;
  }

  const privacyPreferencesKey = storageKey('privacy-preferences-v1');
  try { const preferences = JSON.parse(localStorage.getItem(privacyPreferencesKey) || '{}'); if ($('#recommendation-use-journal')) $('#recommendation-use-journal').checked = preferences.useJournalContext === true; } catch (_) {}
  $('#recommendation-use-journal')?.addEventListener('change', () => {
    recommendationState.signature = '';
    try { const preferences = JSON.parse(localStorage.getItem(privacyPreferencesKey) || '{}'); preferences.useJournalContext = $('#recommendation-use-journal').checked; localStorage.setItem(privacyPreferencesKey, JSON.stringify(preferences)); } catch (_) {}
    renderRecommendations(currentCheckin);
  });
  $('#recommendation-list')?.addEventListener('click', (event) => {
    const activityButton = event.target.closest('[data-recommend-activity]');
    if (activityButton) { window.location.hash = '#wellness-activities'; selectActivity(activityButton.dataset.recommendActivity); return; }
    const dismiss = event.target.closest('[data-dismiss-recommendation]');
    if (!dismiss) return;
    const id = dismiss.dataset.dismissRecommendation;
    recommendationState.dismissed[id] = Date.now();
    recommendationState.current = recommendationState.current.filter((item) => item.id !== id);
    recommendationState.signature = '';
    persistRecommendationState(); renderRecommendations(currentCheckin);
  });

  function readSavedCheckins() {
    try {
      const parsed = JSON.parse(window.localStorage.getItem(HISTORY_KEY) || '[]');
      return Array.isArray(parsed) ? parsed.filter((entry) => entry && typeof entry.id === 'string'
        && typeof entry.createdAt === 'string' && Number.isFinite(Date.parse(entry.createdAt))
        && typeof entry.mood === 'string' && Number.isInteger(entry.intensity)
        && entry.intensity >= 1 && entry.intensity <= 10
        && typeof entry.reflection === 'string').slice(0, 100) : [];
    } catch (_) {
      historyStorageAvailable = false;
      return [];
    }
  }

  function updateDashboardGreeting() {
    const hour = new Date().getHours();
    const greeting = hour < 12 ? 'Good morning' : hour < 17 ? 'Good afternoon' : 'Good evening';
    const heading = $('#greeting');
    if (heading) {
      const name = window.mindfulUser?.display_name?.trim();
      const emphasis = document.createElement('em'); emphasis.textContent = 'wellbeing space';
      heading.replaceChildren(document.createTextNode(name ? `${greeting}, ${name}. Your ` : `${greeting}, welcome to your `), emphasis);
    }
    const date = $('#current-date');
    if (date) {
      date.dateTime = new Date().toISOString();
      date.textContent = new Intl.DateTimeFormat(undefined, { weekday: 'long', month: 'long', day: 'numeric' }).format(new Date());
    }
    const message = $('#daily-message');
    if (message) {
      const day = Math.floor((new Date(new Date().getFullYear(), new Date().getMonth(), new Date().getDate()) - new Date(new Date().getFullYear(), 0, 0)) / 86400000);
      message.textContent = dailyMessages[day % dailyMessages.length];
    }
  }
  window.addEventListener('mindful:profile-updated', updateDashboardGreeting);

  function dateLabel(dateValue, options = { month: 'short', day: 'numeric' }) {
    const date = new Date(dateValue);
    return Number.isNaN(date.getTime()) ? 'Date unavailable' : new Intl.DateTimeFormat(undefined, options).format(date);
  }

  function createHistoryEntry(entry, compact = false) {
    const item = document.createElement('article');
    item.className = compact ? 'journal-entry' : 'history-entry';
    const header = document.createElement('div');
    header.className = 'history-entry-heading';
    const mood = document.createElement('strong');
    mood.textContent = entry.mood || 'Mood not selected';
    const date = document.createElement('time');
    date.dateTime = entry.createdAt;
    date.textContent = dateLabel(entry.createdAt, compact ? { month: 'short', day: 'numeric' } : { weekday: 'short', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });
    header.append(mood, date);
    item.append(header);
    if (!compact) {
      const intensityText = document.createElement('p');
      intensityText.textContent = `Intensity: ${entry.intensity} / 10`;
      item.append(intensityText);
    }
    if (entry.reflection.trim()) {
      const note = document.createElement('p');
      note.className = 'journal-note';
      note.textContent = entry.reflection;
      item.append(note);
    }
    if (!compact) {
      const actions = document.createElement('div');
      actions.className = 'history-entry-actions';
      const edit = document.createElement('button');
      edit.type = 'button';
      edit.className = 'button secondary';
      edit.dataset.entryAction = 'edit';
      edit.dataset.entryId = entry.id;
      edit.textContent = 'Edit';
      edit.setAttribute('aria-label', 'Edit ' + entry.mood + ' check-in from ' + date.textContent);
      const remove = document.createElement('button');
      remove.type = 'button';
      remove.className = 'button delete-checkin';
      remove.dataset.entryAction = 'delete';
      remove.dataset.entryId = entry.id;
      remove.textContent = 'Delete';
      remove.setAttribute('aria-label', 'Delete ' + entry.mood + ' check-in from ' + date.textContent);
      actions.append(edit, remove);
      item.append(actions);
    }
    return item;
  }

  const historyMoods = ['Calm', 'Okay', 'Low', 'Anxious', 'Overwhelmed', 'Not sure'];
  const dateKey = (date) => `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
  const sameDay = (left, right) => dateKey(left) === dateKey(right);
  const localMidnight = (date) => new Date(date.getFullYear(), date.getMonth(), date.getDate());

  const REMINDERS_KEY = storageKey('reminder-settings-v1');
  const reminderTypes = {
    checkin: { title: 'A moment for your mood check-in', body: 'If it feels useful, pause and note how you are feeling.', target: '#check-in-panel', time: '09:00' },
    journal: { title: 'A quiet moment to write', body: 'Your journal is here if you would like to reflect.', target: '#journal-workspace', time: '20:00' },
    activity: { title: 'A mindful moment', body: 'You can choose a short wellbeing activity whenever it suits you.', target: '#activities', time: '12:00' }
  };
  const reminderFrequencies = new Set(['daily', 'weekdays', 'weekly', 'every-other-day']);
  let reminderSettings = {};
  let reminderInterval = null;
  let reminderPermissionPending = false;

  function defaultReminderSettings() {
    return Object.fromEntries(Object.entries(reminderTypes).map(([key, value]) => [key, { enabled: false, time: value.time, frequency: 'daily', anchorDate: dateKey(new Date()), lastSlot: '' }]));
  }

  function loadReminderSettings() {
    const defaults = defaultReminderSettings();
    try {
      const stored = JSON.parse(window.localStorage.getItem(REMINDERS_KEY) || '{}');
      for (const [key, fallback] of Object.entries(defaults)) {
        const item = stored?.[key];
        if (!item || typeof item !== 'object') continue;
        defaults[key] = {
          enabled: item.enabled === true,
          time: typeof item.time === 'string' && /^(?:[01]\d|2[0-3]):[0-5]\d$/.test(item.time) ? item.time : fallback.time,
          frequency: reminderFrequencies.has(item.frequency) ? item.frequency : 'daily',
          anchorDate: typeof item.anchorDate === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(item.anchorDate) ? item.anchorDate : fallback.anchorDate,
          lastSlot: typeof item.lastSlot === 'string' ? item.lastSlot : ''
        };
      }
    } catch (_) { /* Defaults remain available if browser storage is unavailable. */ }
    if (!window.isSecureContext || !('Notification' in window) || Notification.permission !== 'granted') {
      Object.values(defaults).forEach((item) => { item.enabled = false; });
    }
    reminderSettings = defaults;
    try { window.localStorage.setItem(REMINDERS_KEY, JSON.stringify(reminderSettings)); } catch (_) { /* Reminders remain off if preferences cannot be stored. */ }
    renderReminderSettings();
    updateReminderScheduler();
  }

  function reminderPermissionLabel() {
    const privacyNote = ' Reminder times and frequency stay in this browser. Notification text is generic and does not include your mood or journal entries.';
    if (!window.isSecureContext) return 'Notifications need a secure HTTPS connection (or localhost during development).' + privacyNote;
    if (!('Notification' in window)) return 'This browser does not support notifications.' + privacyNote;
    if (Notification.permission === 'granted') return 'Browser permission is allowed. Background tabs may be delayed; reminders are not delivered while Mindful is closed.' + privacyNote;
    if (Notification.permission === 'denied') return 'Browser permission is blocked. Change site notification settings in your browser if you want reminders.' + privacyNote;
    return 'Reminders are off. Browser permission will be requested only when you enable one.' + privacyNote;
  }

  function renderReminderSettings() {
    const timezone = Intl.DateTimeFormat().resolvedOptions().timeZone || 'device local time';
    setInsightText('#reminder-timezone', timezone);
    setInsightText('#reminder-status', reminderPermissionLabel());
    let enabledCount = 0;
    for (const [key, info] of Object.entries(reminderTypes)) {
      const preferences = reminderSettings[key];
      if (preferences.enabled) enabledCount += 1;
      const enabled = $(`#reminder-${key}-enabled`);
      const time = $(`#reminder-${key}-time`);
      const frequency = $(`#reminder-${key}-frequency`);
      if (enabled) enabled.checked = preferences.enabled;
      if (time) { time.value = preferences.time || info.time; time.disabled = !preferences.enabled; }
      if (frequency) { frequency.value = preferences.frequency; frequency.disabled = !preferences.enabled; }
    }
    const turnOff = $('#reminder-turn-off-all');
    if (turnOff) turnOff.disabled = enabledCount === 0;
  }

  function saveReminderSettings(message) {
    try { window.localStorage.setItem(REMINDERS_KEY, JSON.stringify(reminderSettings)); }
    catch (_) {
      Object.values(reminderSettings).forEach((item) => { item.enabled = false; });
      renderReminderSettings();
      updateReminderScheduler();
      setInsightText('#reminder-status', 'Reminder settings could not be saved in this browser. They have been turned off.');
      return;
    }
    renderReminderSettings();
    updateReminderScheduler();
    if (message) setInsightText('#reminder-status', message);
  }

  function reminderSlotFor(key, preferences, now) {
    const day = dateKey(now);
    if (preferences.frequency === 'weekdays' && (now.getDay() === 0 || now.getDay() === 6)) return '';
    if (preferences.frequency === 'weekly' && now.getDay() !== 1) return '';
    if (preferences.frequency === 'every-other-day') {
      const [anchorYear, anchorMonth, anchorDay] = preferences.anchorDate.split('-').map(Number);
      const anchor = Date.UTC(anchorYear, anchorMonth - 1, anchorDay);
      const today = Date.UTC(now.getFullYear(), now.getMonth(), now.getDate());
      const days = Math.floor((today - anchor) / 86400000);
      if (days < 0 || days % 2 !== 0) return '';
    }
    const [hour, minute] = preferences.time.split(':').map(Number);
    if (now.getHours() !== hour || now.getMinutes() !== minute) return '';
    return `${key}:${day}`;
  }

  function checkReminderSchedule() {
    if (!window.isSecureContext || !('Notification' in window) || Notification.permission !== 'granted') {
      if (Object.values(reminderSettings).some((item) => item.enabled)) {
        Object.values(reminderSettings).forEach((item) => { item.enabled = false; });
        saveReminderSettings('Browser notification permission is no longer available. Reminders have been turned off.');
      } else renderReminderSettings();
      return;
    }
    const now = new Date();
    let changed = false;
    for (const [key, preferences] of Object.entries(reminderSettings)) {
      if (!preferences.enabled) continue;
      const slot = reminderSlotFor(key, preferences, now);
      if (!slot || slot === preferences.lastSlot) continue;
      try {
        const info = reminderTypes[key];
        const notification = new Notification(info.title, { body: info.body, tag: `mindful-${slot}`, renotify: false, silent: true });
        notification.onclick = () => { window.focus(); window.location.hash = info.target; notification.close(); };
        preferences.lastSlot = slot;
        changed = true;
      } catch (_) {
        setInsightText('#reminder-status', 'The browser could not display a notification. Your reminder settings are still available to change.');
      }
    }
    if (changed) {
      try { window.localStorage.setItem(REMINDERS_KEY, JSON.stringify(reminderSettings)); } catch (_) { /* The notification has already been delivered. */ }
    }
  }

  function updateReminderScheduler() {
    const shouldRun = Object.values(reminderSettings).some((item) => item.enabled) && window.isSecureContext && 'Notification' in window && Notification.permission === 'granted';
    if (!shouldRun && reminderInterval) { window.clearInterval(reminderInterval); reminderInterval = null; }
    if (shouldRun && !reminderInterval) reminderInterval = window.setInterval(checkReminderSchedule, 30000);
    if (shouldRun) checkReminderSchedule();
  }

  async function changeReminderEnabled(key, enabled) {
    const checkbox = $(`#reminder-${key}-enabled`);
    const preferences = reminderSettings[key];
    if (!preferences) return;
    if (!enabled) {
      preferences.enabled = false;
      saveReminderSettings('That reminder is off.');
      return;
    }
    if (reminderPermissionPending) { if (checkbox) checkbox.checked = false; return; }
    if (!window.isSecureContext || !('Notification' in window)) {
      preferences.enabled = false;
      if (checkbox) checkbox.checked = false;
      renderReminderSettings();
      setInsightText('#reminder-status', reminderPermissionLabel());
      return;
    }
    reminderPermissionPending = true;
    try {
      let permission = Notification.permission;
      if (permission === 'default') {
        setInsightText('#reminder-status', 'Choose Allow in the browser prompt to turn on this reminder.');
        permission = await Notification.requestPermission();
      }
      if (permission !== 'granted') {
        preferences.enabled = false;
        if (checkbox) checkbox.checked = false;
        renderReminderSettings();
        setInsightText('#reminder-status', permission === 'denied' ? 'Browser permission was not granted. This reminder remains off.' : 'This reminder remains off because notification permission was not granted.');
        return;
      }
      preferences.enabled = true;
      preferences.anchorDate = dateKey(new Date());
      saveReminderSettings('Reminder enabled for this device’s local time and frequency. Keep Mindful open; background tabs may be delayed.');
    } catch (_) {
      preferences.enabled = false;
      if (checkbox) checkbox.checked = false;
      renderReminderSettings();
      setInsightText('#reminder-status', 'The browser could not enable notifications. You can keep using Mindful without reminders.');
    } finally { reminderPermissionPending = false; }
  }

  function initializeReminders() {
    loadReminderSettings();
    for (const key of Object.keys(reminderTypes)) {
      $(`#reminder-${key}-enabled`)?.addEventListener('change', (event) => changeReminderEnabled(key, event.currentTarget.checked));
      $(`#reminder-${key}-time`)?.addEventListener('change', (event) => {
        if (!/^(?:[01]\d|2[0-3]):[0-5]\d$/.test(event.currentTarget.value)) return;
        reminderSettings[key].time = event.currentTarget.value;
        saveReminderSettings('Reminder time saved in this device’s timezone.');
      });
      $(`#reminder-${key}-frequency`)?.addEventListener('change', (event) => {
        if (!reminderFrequencies.has(event.currentTarget.value)) return;
        reminderSettings[key].frequency = event.currentTarget.value;
        reminderSettings[key].anchorDate = dateKey(new Date());
        saveReminderSettings('Reminder frequency saved.');
      });
    }
    $('#reminder-turn-off-all')?.addEventListener('click', () => {
      Object.values(reminderSettings).forEach((item) => { item.enabled = false; });
      saveReminderSettings('All reminders are off. Browser notification permission remains controlled in your browser settings.');
    });
    document.addEventListener('visibilitychange', () => { if (!document.hidden) { renderReminderSettings(); checkReminderSchedule(); } });
    window.addEventListener('focus', () => { renderReminderSettings(); checkReminderSchedule(); });
    try {
      const queryPermissions = navigator.permissions?.query;
      if (queryPermissions) queryPermissions.call(navigator.permissions, { name: 'notifications' }).then((permission) => {
        permission.addEventListener?.('change', () => {
          renderReminderSettings();
          if ('Notification' in window && Notification.permission !== 'granted' && Object.values(reminderSettings).some((item) => item.enabled)) {
            Object.values(reminderSettings).forEach((item) => { item.enabled = false; });
            saveReminderSettings('Browser notification permission changed. Reminders have been turned off.');
          }
        });
      }).catch(() => { /* Permission status is refreshed when the app regains focus. */ });
    } catch (_) { /* Permission status is refreshed when the app regains focus. */ }
  }
  initializeReminders();

  function setInsightText(selector, value) { const element = $(selector); if (element) element.textContent = value; }

  function insightEmpty(container, message) {
    const element = $(container); if (!element) return;
    element.replaceChildren(); const empty = document.createElement('p'); empty.className = 'insight-insufficient'; empty.textContent = message; element.append(empty);
  }

  function renderInsightsDashboard() {
    if (!$('#insights-dashboard')) return;
    const now = new Date(); const today = localMidnight(now); const weekStart = new Date(today.getFullYear(), today.getMonth(), today.getDate() - 6);
    const monthStart = new Date(now.getFullYear(), now.getMonth(), 1);
    const within = (value, start, end = now) => { const time = new Date(value).getTime(); return Number.isFinite(time) && time >= start.getTime() && time <= end.getTime(); };
    const weekly = savedCheckins.filter((entry) => within(entry.createdAt, weekStart));
    const monthly = savedCheckins.filter((entry) => within(entry.createdAt, monthStart));
    const weekSummary = $('#insights-week-summary');
    if (weekSummary) weekSummary.textContent = weekly.length
      ? `${weekly.length} saved ${weekly.length === 1 ? 'check-in' : 'check-ins'} across ${new Set(weekly.map((entry) => dateKey(new Date(entry.createdAt)))).size} recorded days. ${new Set(weekly.map((entry) => entry.mood)).size} different self-reported ${new Set(weekly.map((entry) => entry.mood)).size === 1 ? 'mood' : 'moods'} recorded.`
      : 'Insufficient saved check-ins for a weekly mood summary.';
    const weekBars = $('#insights-week-bars');
    if (weekBars) {
      weekBars.replaceChildren();
      const daily = Array.from({ length: 7 }, (_, offset) => {
        const date = new Date(weekStart.getFullYear(), weekStart.getMonth(), weekStart.getDate() + offset);
        const entries = weekly.filter((entry) => sameDay(new Date(entry.createdAt), date));
        return { date, entries };
      });
      const maxCount = Math.max(1, ...daily.map((day) => day.entries.length));
      daily.forEach(({ date, entries }) => {
        const column = document.createElement('div'); column.className = 'insight-week-day'; column.setAttribute('role', 'listitem');
        const count = document.createElement('span'); count.className = 'insight-week-count'; count.textContent = String(entries.length);
        const track = document.createElement('span'); track.className = 'insight-week-track'; const fill = document.createElement('span'); fill.className = 'insight-week-fill'; fill.style.height = `${entries.length ? Math.max(8, entries.length / maxCount * 100) : 0}%`; track.append(fill);
        const label = document.createElement('span'); label.className = 'insight-week-label'; label.textContent = new Intl.DateTimeFormat(undefined, { weekday: 'short' }).format(date);
        const readable = document.createElement('span'); readable.className = 'sr-only'; readable.textContent = `${journalDateLabel(date, { weekday: 'long', month: 'long', day: 'numeric' })}: ${entries.length} saved ${entries.length === 1 ? 'check-in' : 'check-ins'}`;
        column.append(count, track, label, readable); weekBars.append(column);
      });
    }
    const weekMoods = $('#insights-week-moods');
    if (weekMoods) {
      weekMoods.replaceChildren();
      const counts = new Map(); weekly.forEach((entry) => counts.set(entry.mood, (counts.get(entry.mood) || 0) + 1));
      if (counts.size) [...counts.entries()].sort((a, b) => b[1] - a[1]).forEach(([mood, count]) => { const chip = document.createElement('span'); chip.className = 'insight-mood-chip'; chip.textContent = `${mood} · ${count}`; weekMoods.append(chip); });
    }

    const monthSummary = $('#insights-month-summary');
    if (monthSummary) {
      const days = new Set(monthly.map((entry) => dateKey(new Date(entry.createdAt))));
      const average = monthly.length ? monthly.reduce((sum, entry) => sum + entry.intensity, 0) / monthly.length : 0;
      monthSummary.textContent = monthly.length
        ? `${monthly.length} saved ${monthly.length === 1 ? 'check-in' : 'check-ins'} across ${days.size} recorded ${days.size === 1 ? 'day' : 'days'} this month. Average self-reported intensity: ${average.toFixed(1)} / 10.`
        : 'Insufficient saved check-ins for a monthly mood overview.';
    }
    const monthMoods = $('#insights-month-moods');
    if (monthMoods) {
      monthMoods.replaceChildren();
      if (!monthly.length) insightEmpty('#insights-month-moods', 'Mood summaries will appear after you save a check-in.');
      else [...new Set(monthly.map((entry) => entry.mood))].forEach((mood) => { const chip = document.createElement('span'); chip.className = 'insight-mood-chip'; chip.textContent = `${mood} · ${monthly.filter((entry) => entry.mood === mood).length}`; monthMoods.append(chip); });
    }

    const frequency = $('#insights-frequency-chart');
    setInsightText('#insights-frequency-summary', monthly.length ? `${monthly.length} saved check-ins in ${new Intl.DateTimeFormat(undefined, { month: 'long' }).format(now)}.` : 'Not enough saved check-ins yet to summarize mood frequency.');
    if (frequency) {
      frequency.replaceChildren();
      if (!monthly.length) insightEmpty('#insights-frequency-chart', 'Save check-ins to see the moods you recorded.');
      else {
        const counts = new Map(); monthly.forEach((entry) => counts.set(entry.mood, (counts.get(entry.mood) || 0) + 1));
        [...counts.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])).forEach(([mood, count]) => {
          const row = document.createElement('div'); row.className = 'insights-frequency-row';
          const label = document.createElement('span'); label.textContent = mood;
          const track = document.createElement('span'); track.className = 'insights-frequency-track'; track.setAttribute('role', 'meter'); track.setAttribute('aria-label', `${mood}: ${count} of ${monthly.length} saved check-ins`); track.setAttribute('aria-valuemin', '0'); track.setAttribute('aria-valuemax', String(monthly.length)); track.setAttribute('aria-valuenow', String(count));
          const fill = document.createElement('span'); fill.className = 'insights-frequency-fill'; fill.style.width = `${count / monthly.length * 100}%`; track.append(fill);
          const value = document.createElement('strong'); value.textContent = `${count} · ${Math.round(count / monthly.length * 100)}%`; row.append(label, track, value); frequency.append(row);
        });
      }
    }

    const intensityChart = $('#insights-intensity-chart');
    setInsightText('#insights-intensity-summary', monthly.length ? 'Daily averages from your saved self-reported intensity ratings. Gaps mean no check-in was saved.' : 'Not enough saved ratings yet to show an intensity trend.');
    if (intensityChart) {
      intensityChart.replaceChildren();
      if (!monthly.length) insightEmpty('#insights-intensity-chart', 'Intensity points will appear after you save check-ins.');
      else {
        const groups = new Map(); monthly.forEach((entry) => { const key = dateKey(new Date(entry.createdAt)); const prior = groups.get(key) || { date: localMidnight(new Date(entry.createdAt)), total: 0, count: 0 }; prior.total += entry.intensity; prior.count += 1; groups.set(key, prior); });
        const days = [...groups.values()].sort((a, b) => a.date - b.date).map((day) => ({ ...day, average: day.total / day.count }));
        const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg'); svg.setAttribute('viewBox', '0 0 700 250'); svg.setAttribute('preserveAspectRatio', 'xMidYMid meet'); svg.setAttribute('role', 'img'); svg.setAttribute('aria-label', `Self-reported intensity, from 1 to 10, by recorded day this month. ${days.length} days with saved check-ins.`);
        const ns = 'http://www.w3.org/2000/svg'; const plot = { left: 42, right: 686, top: 18, bottom: 195 };
        const yFor = (value) => plot.bottom - (value - 1) / 9 * (plot.bottom - plot.top);
        [1, 5, 10].forEach((value) => { const y = yFor(value); const line = document.createElementNS(ns, 'line'); line.setAttribute('x1', String(plot.left)); line.setAttribute('x2', String(plot.right)); line.setAttribute('y1', String(y)); line.setAttribute('y2', String(y)); line.setAttribute('class', 'insights-grid-line'); const label = document.createElementNS(ns, 'text'); label.setAttribute('x', '8'); label.setAttribute('y', String(y + 4)); label.setAttribute('class', 'insights-axis-label'); label.textContent = String(value); svg.append(line, label); });
        const first = days[0].date.getTime(); const last = days.at(-1).date.getTime(); const xFor = (date) => last === first ? (plot.left + plot.right) / 2 : plot.left + (date.getTime() - first) / (last - first) * (plot.right - plot.left);
        days.slice(1).forEach((day, index) => { const prior = days[index]; if (Math.round((day.date - prior.date) / 86400000) !== 1) return; const line = document.createElementNS(ns, 'line'); line.setAttribute('x1', String(xFor(prior.date))); line.setAttribute('y1', String(yFor(prior.average))); line.setAttribute('x2', String(xFor(day.date))); line.setAttribute('y2', String(yFor(day.average))); line.setAttribute('class', 'insights-trend-line'); svg.append(line); });
        days.forEach((day, index) => { const x = xFor(day.date); const y = yFor(day.average); const point = document.createElementNS(ns, 'circle'); point.setAttribute('cx', String(x)); point.setAttribute('cy', String(y)); point.setAttribute('r', '5'); point.setAttribute('class', 'insights-trend-point'); const title = document.createElementNS(ns, 'title'); title.textContent = `${dateLabel(day.date, { month: 'short', day: 'numeric' })}: ${day.average.toFixed(1)} average from ${day.count} check-ins`; point.append(title); svg.append(point); if (index === 0 || index === days.length - 1 || index % Math.ceil(days.length / 6) === 0) { const label = document.createElementNS(ns, 'text'); label.setAttribute('x', String(x)); label.setAttribute('y', '224'); label.setAttribute('text-anchor', 'middle'); label.setAttribute('class', 'insights-axis-label'); label.textContent = dateLabel(day.date, { month: 'numeric', day: 'numeric' }); svg.append(label); } });
        intensityChart.append(svg);
        const accessible = document.createElement('p'); accessible.className = 'sr-only'; accessible.textContent = days.map((day) => `${dateLabel(day.date, { month: 'short', day: 'numeric' })}: average intensity ${day.average.toFixed(1)} from ${day.count} saved check-ins`).join('. '); intensityChart.append(accessible);
      }
    }

    const checkinDays = new Map(); savedCheckins.slice().sort((a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt)).forEach((entry) => { const key = dateKey(new Date(entry.createdAt)); const group = checkinDays.get(key) || { date: new Date(entry.createdAt), moods: [], count: 0 }; group.moods.push(entry.mood); group.count += 1; checkinDays.set(key, group); });
    const checkinDayList = $('#insights-checkin-days');
    setInsightText('#insights-checkin-summary', savedCheckins.length ? `${savedCheckins.length} saved check-ins across ${checkinDays.size} recorded days. No daily target is assumed.` : 'No saved check-ins yet, so there is no check-in history to summarize.');
    if (checkinDayList) { checkinDayList.replaceChildren(); if (!savedCheckins.length) insightEmpty('#insights-checkin-days', 'Saved check-ins will appear here when you choose to keep them.'); else [...checkinDays.values()].slice(0, 8).forEach((day) => { const row = document.createElement('div'); row.className = 'insights-record-row'; const label = document.createElement('span'); label.textContent = dateLabel(day.date, { weekday: 'short', month: 'short', day: 'numeric' }); const detail = document.createElement('strong'); detail.textContent = `${day.count} · ${[...new Set(day.moods)].join(', ')}`; row.append(label, detail); checkinDayList.append(row); }); }

    const savedJournal = journalEntries.filter((entry) => within(entry.date, monthStart));
    const checkinReflections = savedCheckins.filter((entry) => entry.reflection?.trim() && within(entry.createdAt, monthStart));
    const allReflections = savedJournal.length + checkinReflections.length;
    setInsightText('#insights-journal-summary', allReflections ? `${allReflections} saved ${allReflections === 1 ? 'reflection' : 'reflections'} this month: ${savedJournal.length} journal ${savedJournal.length === 1 ? 'entry' : 'entries'} and ${checkinReflections.length} check-in ${checkinReflections.length === 1 ? 'note' : 'notes'}.` : 'No saved journal entries or check-in reflections this month.');
    const tags = $('#insights-journal-tags');
    if (tags) { tags.replaceChildren(); if (!savedJournal.length && !checkinReflections.length) insightEmpty('#insights-journal-tags', 'Reflection activity will appear here after you save writing.'); else if (!savedJournal.some((entry) => entry.tags?.length)) insightEmpty('#insights-journal-tags', `${savedJournal.length} journal ${savedJournal.length === 1 ? 'entry has' : 'entries have'} no saved tags.`); else { const counts = new Map(); savedJournal.forEach((entry) => (entry.tags || []).forEach((tag) => counts.set(tag, (counts.get(tag) || 0) + 1))); [...counts.entries()].sort((a, b) => b[1] - a[1]).slice(0, 8).forEach(([tag, count]) => { const chip = document.createElement('span'); chip.className = 'insight-tag'; chip.textContent = `${tag} · ${count}`; tags.append(chip); }); } }

    const monthActivities = savedActivities.filter((item) => within(item.completedAt, monthStart));
    setInsightText('#insights-activity-summary', monthActivities.length ? `${monthActivities.length} completed ${monthActivities.length === 1 ? 'activity' : 'activities'} saved this month. Only activities you opted to save are included.` : 'No saved activity completions this month. Unsaved sessions are not recorded.');
    const activityList = $('#insights-activity-list');
    if (activityList) { activityList.replaceChildren(); if (!monthActivities.length) insightEmpty('#insights-activity-list', 'Opt-in saved completions will appear here.'); else { const counts = new Map(); monthActivities.forEach((item) => counts.set(item.title, (counts.get(item.title) || 0) + 1)); [...counts.entries()].sort((a, b) => b[1] - a[1]).forEach(([title, count]) => { const row = document.createElement('div'); row.className = 'insights-record-row'; const label = document.createElement('span'); label.textContent = title; const amount = document.createElement('strong'); amount.textContent = `${count} saved`; row.append(label, amount); activityList.append(row); }); } }

    const prompts = $('#insights-prompts'); if (prompts) {
      prompts.replaceChildren(); const promptList = [];
      if (weekly.length) promptList.push(`You saved ${weekly.length} check-ins across ${new Set(weekly.map((entry) => dateKey(new Date(entry.createdAt)))).size} days this week. Is there one moment you would like to reflect on?`);
      if (allReflections) promptList.push(`You saved ${allReflections} reflection${allReflections === 1 ? '' : 's'} this month. Would you like to revisit one or leave it as it is?`);
      if (monthActivities.length) promptList.push(`You chose to save ${monthActivities.length} completed activit${monthActivities.length === 1 ? 'y' : 'ies'} this month. Is there one you would like to return to?`);
      if (!promptList.length) promptList.push('What would you like a future check-in or reflection to help you remember?');
      promptList.slice(0, 3).forEach((text) => { const item = document.createElement('li'); item.textContent = text; prompts.append(item); });
    }
    setInsightText('#insights-prompt-context', savedCheckins.length || journalEntries.length || savedActivities.length ? 'These prompts refer only to saved items and do not infer causes or relationships.' : 'There is not enough saved data for a personal summary yet. Here is a general prompt to start with.');
  }

  function appendTrendChart(entries) {
    const chart = $('#intensity-chart');
    const summary = $('#intensity-summary');
    if (!chart || !summary) return;
    chart.replaceChildren();
    if (!entries.length) {
      summary.textContent = 'No saved check-ins in this period, so there is no trend to show.';
      const empty = document.createElement('p');
      empty.className = 'empty-inline';
      empty.textContent = 'Intensity trends appear after you save a check-in.';
      chart.append(empty);
      return;
    }

    const byDay = new Map();
    for (const entry of entries) {
      const date = new Date(entry.createdAt);
      const key = dateKey(date);
      const current = byDay.get(key) || { date: localMidnight(date), total: 0, count: 0 };
      current.total += entry.intensity;
      current.count += 1;
      byDay.set(key, current);
    }
    const days = [...byDay.values()].sort((a, b) => a.date - b.date).map((day) => ({ ...day, average: day.total / day.count }));
    const average = entries.reduce((sum, entry) => sum + entry.intensity, 0) / entries.length;
    const recordedDays = days.length;
    const gaps = days.length > 1 ? Math.max(0, Math.round((days.at(-1).date - days[0].date) / 86400000) + 1 - recordedDays) : 0;
    summary.textContent = `${entries.length} saved ${entries.length === 1 ? 'check-in' : 'check-ins'} across ${recordedDays} ${recordedDays === 1 ? 'day' : 'days'}; average intensity ${average.toFixed(1)} out of 10.${gaps ? ` ${gaps} intervening ${gaps === 1 ? 'day has' : 'days have'} no saved check-in and are left blank.` : ''}`;

    const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    svg.setAttribute('viewBox', '0 0 700 230');
    svg.setAttribute('preserveAspectRatio', 'none');
    svg.setAttribute('role', 'img');
    svg.setAttribute('aria-label', `Average self-reported intensity by recorded day, from ${dateLabel(days[0].date, { month: 'long', day: 'numeric', year: 'numeric' })} to ${dateLabel(days.at(-1).date, { month: 'long', day: 'numeric', year: 'numeric' })}. Blank dates mean no check-in was saved.`);
    const ns = 'http://www.w3.org/2000/svg';
    const plot = { left: 42, right: 680, top: 20, bottom: 180 };
    const yFor = (value) => plot.bottom - ((value - 1) / 9) * (plot.bottom - plot.top);
    for (const value of [1, 5, 10]) {
      const y = yFor(value);
      const line = document.createElementNS(ns, 'line');
      line.setAttribute('x1', String(plot.left)); line.setAttribute('x2', String(plot.right)); line.setAttribute('y1', String(y)); line.setAttribute('y2', String(y)); line.setAttribute('class', 'trend-grid-line');
      const label = document.createElementNS(ns, 'text');
      label.setAttribute('x', '4'); label.setAttribute('y', String(y + 4)); label.setAttribute('class', 'trend-axis-label'); label.textContent = String(value);
      svg.append(line, label);
    }
    const minTime = days[0].date.getTime();
    const maxTime = days.at(-1).date.getTime();
    const xFor = (date) => maxTime === minTime ? (plot.left + plot.right) / 2 : plot.left + ((date.getTime() - minTime) / (maxTime - minTime)) * (plot.right - plot.left);
    for (let index = 0; index < days.length - 1; index += 1) {
      const current = days[index]; const next = days[index + 1];
      if (Math.round((next.date - current.date) / 86400000) !== 1) continue;
      const line = document.createElementNS(ns, 'line');
      line.setAttribute('x1', String(xFor(current.date))); line.setAttribute('y1', String(yFor(current.average)));
      line.setAttribute('x2', String(xFor(next.date))); line.setAttribute('y2', String(yFor(next.average)));
      line.setAttribute('class', 'trend-line'); svg.append(line);
    }
    for (const day of days) {
      const x = xFor(day.date); const y = yFor(day.average);
      const point = document.createElementNS(ns, 'circle');
      point.setAttribute('cx', String(x)); point.setAttribute('cy', String(y)); point.setAttribute('r', '5'); point.setAttribute('class', 'trend-point'); svg.append(point);
      const label = document.createElementNS(ns, 'text');
      label.setAttribute('x', String(x)); label.setAttribute('y', '207'); label.setAttribute('text-anchor', 'middle'); label.setAttribute('class', 'trend-date-label');
      label.textContent = dateLabel(day.date, { month: 'numeric', day: 'numeric' }); svg.append(label);
    }
    chart.append(svg);
    const dataList = document.createElement('ul');
    dataList.className = 'trend-data-list';
    for (const day of days) {
      const item = document.createElement('li');
      item.textContent = `${dateLabel(day.date, { weekday: 'short', month: 'short', day: 'numeric' })}: average intensity ${day.average.toFixed(1)} from ${day.count} ${day.count === 1 ? 'check-in' : 'check-ins'}`;
      dataList.append(item);
    }
    chart.append(dataList);
  }

  function renderMoodHistory() {
    const tools = $('#history-tools');
    const empty = $('#history-empty');
    const hasHistory = savedCheckins.length > 0;
    if (tools) tools.hidden = !hasHistory;
    if (empty) empty.hidden = hasHistory;
    if (!hasHistory) return;
    if (selectedHistoryDate && !savedCheckins.some((entry) => dateKey(new Date(entry.createdAt)) === selectedHistoryDate)) selectedHistoryDate = null;

    const monthLabel = $('#calendar-month-label');
    if (monthLabel) monthLabel.textContent = new Intl.DateTimeFormat(undefined, { month: 'long', year: 'numeric' }).format(calendarMonth);
    const calendar = $('#history-calendar');
    if (calendar) {
      calendar.replaceChildren();
      const firstOfMonth = new Date(calendarMonth.getFullYear(), calendarMonth.getMonth(), 1);
      const leadingDays = (firstOfMonth.getDay() + 6) % 7;
      for (let index = 0; index < leadingDays; index += 1) {
        const blank = document.createElement('span'); blank.className = 'calendar-blank'; blank.setAttribute('aria-hidden', 'true'); calendar.append(blank);
      }
      const daysInMonth = new Date(calendarMonth.getFullYear(), calendarMonth.getMonth() + 1, 0).getDate();
      const entriesByDay = new Map();
      for (const entry of savedCheckins) {
        const key = dateKey(new Date(entry.createdAt));
        const items = entriesByDay.get(key) || []; items.push(entry); entriesByDay.set(key, items);
      }
      for (let dayNumber = 1; dayNumber <= daysInMonth; dayNumber += 1) {
        const date = new Date(calendarMonth.getFullYear(), calendarMonth.getMonth(), dayNumber);
        const key = dateKey(date);
        const entries = entriesByDay.get(key) || [];
        const button = document.createElement(entries.length ? 'button' : 'div');
        if (entries.length) { button.type = 'button'; button.dataset.historyDate = key; }
        else { button.classList.add('calendar-missing'); button.setAttribute('role', 'img'); }
        button.classList.add('calendar-day');
        if (entries.length) button.classList.add('has-checkin');
        if (key === selectedHistoryDate) button.classList.add('selected');
        if (sameDay(date, new Date())) button.classList.add('is-today');
        if (entries.length) button.setAttribute('aria-pressed', String(key === selectedHistoryDate));
        const moodNames = [...new Set(entries.map((entry) => entry.mood))].join(', ');
        button.setAttribute('aria-label', `${dateLabel(date, { weekday: 'long', month: 'long', day: 'numeric', year: 'numeric' })}: ${entries.length ? `${moodNames}, ${entries.length} ${entries.length === 1 ? 'check-in' : 'check-ins'}` : 'No check-in saved'}`);
        const number = document.createElement('span'); number.className = 'calendar-date-number'; number.textContent = String(dayNumber);
        const mood = document.createElement('span'); mood.className = 'calendar-day-mood'; mood.textContent = entries.length ? entries[0].mood : 'No check-in';
        const count = document.createElement('span'); count.className = 'calendar-day-count'; count.textContent = entries.length > 1 ? `${entries.length} entries` : entries.length ? `${entries[0].intensity}/10` : '';
        button.append(number, mood, count); calendar.append(button);
      }
    }

    const selectedEntries = selectedHistoryDate ? savedCheckins.filter((entry) => dateKey(new Date(entry.createdAt)) === selectedHistoryDate).sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt)) : [];
    const selectedPanel = $('#selected-day-panel');
    const selectedTitle = $('#selected-day-title');
    const selectedList = $('#selected-day-list');
    if (selectedPanel) selectedPanel.hidden = selectedEntries.length === 0;
    if (selectedTitle && selectedHistoryDate) selectedTitle.textContent = `Check-ins for ${dateLabel(new Date(`${selectedHistoryDate}T12:00:00`), { weekday: 'long', month: 'long', day: 'numeric', year: 'numeric' })}`;
    if (selectedList) selectedList.replaceChildren(...selectedEntries.map((entry) => createHistoryEntry(entry)));
    const calendarStatus = $('#calendar-status');
    if (calendarStatus) calendarStatus.textContent = selectedEntries.length
      ? `${selectedEntries.length} saved ${selectedEntries.length === 1 ? 'check-in' : 'check-ins'} selected. Each entry is shown below.`
      : 'Choose a date with a saved check-in to review it. Dates without check-ins are labeled and disabled.';

    const rangeSelect = $('#history-range');
    if (rangeSelect && rangeSelect.value !== historyRange) rangeSelect.value = historyRange;
    const now = new Date();
    let filteredEntries;
    if (historyRange === 'week') {
      const start = localMidnight(now); start.setDate(start.getDate() - 6);
      filteredEntries = savedCheckins.filter((entry) => { const date = new Date(entry.createdAt); return date >= start && date <= now; });
    } else if (historyRange === 'month') {
      filteredEntries = savedCheckins.filter((entry) => { const date = new Date(entry.createdAt); return date.getFullYear() === calendarMonth.getFullYear() && date.getMonth() === calendarMonth.getMonth(); });
    } else filteredEntries = [...savedCheckins];
    filteredEntries.sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));
    const rangeSummary = $('#history-range-summary');
    if (rangeSummary) rangeSummary.textContent = `${filteredEntries.length} saved ${filteredEntries.length === 1 ? 'check-in' : 'check-ins'} in this view.`;

    const frequency = $('#mood-frequency');
    const frequencySummary = $('#frequency-summary');
    if (frequency && frequencySummary) {
      frequency.replaceChildren();
      if (!filteredEntries.length) {
        frequencySummary.textContent = 'No saved mood data for this period.';
        const note = document.createElement('p'); note.className = 'empty-inline'; note.textContent = 'Mood counts will appear after you save a check-in.'; frequency.append(note);
      } else {
        const counts = new Map(historyMoods.map((mood) => [mood, 0]));
        for (const entry of filteredEntries) counts.set(entry.mood, (counts.get(entry.mood) || 0) + 1);
        const maximum = Math.max(...counts.values(), 1);
        frequencySummary.textContent = `Counts from ${filteredEntries.length} saved ${filteredEntries.length === 1 ? 'check-in' : 'check-ins'} in this period.`;
        for (const [mood, count] of counts) {
          const row = document.createElement('div'); row.className = 'frequency-row';
          const label = document.createElement('span'); label.className = 'frequency-mood'; label.textContent = mood;
          const meter = document.createElement('span'); meter.className = 'frequency-meter'; meter.setAttribute('role', 'meter'); meter.setAttribute('aria-label', `${mood}: ${count} saved ${count === 1 ? 'check-in' : 'check-ins'}`); meter.setAttribute('aria-valuemin', '0'); meter.setAttribute('aria-valuemax', String(maximum)); meter.setAttribute('aria-valuenow', String(count));
          const fill = document.createElement('span'); fill.className = 'frequency-fill'; fill.style.width = `${count / maximum * 100}%`; meter.append(fill);
          const value = document.createElement('strong'); value.className = 'frequency-count'; value.textContent = String(count);
          row.append(label, meter, value); frequency.append(row);
        }
      }
    }
    appendTrendChart(filteredEntries);

    const list = $('#history-list');
    const listEmpty = $('#history-list-empty');
    if (list) { list.hidden = filteredEntries.length === 0; list.replaceChildren(...filteredEntries.map((entry) => createHistoryEntry(entry))); }
    if (listEmpty) listEmpty.hidden = filteredEntries.length > 0;
    const clearHistory = $('#clear-checkin-history');
    if (clearHistory) clearHistory.disabled = savedCheckins.length === 0;
  }

  function renderDashboard(ephemeralEntry = currentCheckin) {
    updateDashboardGreeting();
    const now = new Date();
    const dayStart = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
    const todayEntries = savedCheckins.filter((entry) => new Date(entry.createdAt).getTime() >= dayStart && new Date(entry.createdAt).getTime() <= now.getTime());
    const currentToday = ephemeralEntry && new Date(ephemeralEntry.createdAt).getTime() >= dayStart ? ephemeralEntry : null;
    const today = currentToday || todayEntries[0];
    const todayState = $('#today-mood-state');
    const todayDetail = $('#today-mood-detail');
    if (todayState) todayState.textContent = today ? (today.mood === 'Not shared' ? 'Mood not selected' : today.mood) : 'No check-in yet';
    if (todayDetail) todayDetail.textContent = today
      ? `You rated the feeling ${today.intensity} out of 10.`
      : 'Your mood will appear here after you check in.';

    const weekStart = dayStart - 6 * 86400000;
    const weekly = savedCheckins.filter((entry) => {
      const time = new Date(entry.createdAt).getTime();
      return time >= weekStart && time <= now.getTime();
    });
    const weekEmpty = $('#weekly-empty');
    const weekSummary = $('#weekly-summary');
    if (weekEmpty) weekEmpty.hidden = weekly.length > 0;
    if (weekSummary) weekSummary.hidden = weekly.length === 0;
    if (weekly.length) {
      const count = $('#weekly-checkin-count');
      const average = $('#weekly-average');
      if (count) count.textContent = String(weekly.length);
      if (average) average.textContent = `${(weekly.reduce((sum, entry) => sum + entry.intensity, 0) / weekly.length).toFixed(1)} / 10`;
      const chart = $('#weekly-chart');
      if (chart) {
        chart.replaceChildren();
        for (let offset = 6; offset >= 0; offset -= 1) {
          const date = new Date(dayStart - offset * 86400000);
          const dayEntries = weekly.filter((entry) => {
            const savedDate = new Date(entry.createdAt);
            return savedDate.getFullYear() === date.getFullYear() && savedDate.getMonth() === date.getMonth() && savedDate.getDate() === date.getDate();
          });
          const mean = dayEntries.length ? dayEntries.reduce((sum, entry) => sum + entry.intensity, 0) / dayEntries.length : 0;
          const column = document.createElement('div');
          column.className = 'weekly-day';
          column.setAttribute('role', 'listitem');
          const bar = document.createElement('span');
          bar.className = 'weekly-bar';
          bar.style.height = `${mean ? Math.max(10, mean * 8) : 4}px`;
          bar.setAttribute('aria-hidden', 'true');
          const label = document.createElement('small');
          label.textContent = new Intl.DateTimeFormat(undefined, { weekday: 'short' }).format(date);
          const countLabel = document.createElement('span');
          countLabel.className = 'sr-only';
          countLabel.textContent = `${label.textContent}: ${dayEntries.length ? `average intensity ${mean.toFixed(1)} from ${dayEntries.length} check-ins` : 'no saved check-ins'}`;
          column.append(bar, label, countLabel);
          chart.append(column);
        }
      }
    }

    const recentReflections = savedCheckins.filter((entry) => entry.reflection.trim()).slice(0, 3);
    const journalEmpty = $('#journal-empty');
    const journalList = $('#journal-list');
    if (journalEmpty) journalEmpty.hidden = recentReflections.length > 0;
    if (journalList) {
      journalList.hidden = recentReflections.length === 0;
      journalList.replaceChildren(...recentReflections.map((entry) => createHistoryEntry(entry, true)));
    }

    renderMoodHistory();
    renderJournalMoodOptions();
    renderRecommendations(ephemeralEntry);
    renderInsightsDashboard();
    const saveToggle = $('#save-checkin-history');
    if (saveToggle && !historyStorageAvailable) {
      saveToggle.disabled = true;
      const label = $('label[for="save-checkin-history"]');
      if (label) label.textContent = 'Local history is unavailable in this browser';
    }
  }

  function localDateTimeValue(date = new Date()) {
    const local = new Date(date.getTime() - date.getTimezoneOffset() * 60000);
    return local.toISOString().slice(0, 16);
  }

  function renderJournalMoodOptions(selected = '') {
    const select = $('#journal-mood');
    if (!select) return;
    const current = selected || select.value;
    select.replaceChildren(new Option('No linked check-in', ''));
    savedCheckins.slice().sort((a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt)).forEach((entry) => {
      const option = new Option(`${entry.mood || 'Mood not selected'} · ${dateLabel(entry.createdAt, { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' })}`, entry.id);
      select.append(option);
    });
    if ([...select.options].some((option) => option.value === current)) select.value = current;
  }

  function journalDateLabel(value, options = { weekday: 'short', month: 'long', day: 'numeric', year: 'numeric', hour: 'numeric', minute: '2-digit' }) {
    const date = new Date(value);
    return Number.isNaN(date.getTime()) ? 'Date unavailable' : new Intl.DateTimeFormat(undefined, options).format(date);
  }

  function renderJournal() {
    const list = $('#journal-entries');
    if (!list) return;
    renderJournalMoodOptions();
    const query = ($('#journal-search')?.value || '').trim().toLocaleLowerCase();
    const filterDate = $('#journal-date-filter')?.value || '';
    const filtered = journalEntries.filter((entry) => {
      const day = localDateTimeValue(new Date(entry.date)).slice(0, 10);
      const haystack = `${entry.title} ${entry.body} ${(entry.tags || []).join(' ')}`.toLocaleLowerCase();
      return (!query || haystack.includes(query)) && (!filterDate || filterDate === day);
    });
    list.replaceChildren();
    filtered.slice(0, journalVisibleLimit).forEach((entry) => {
      const card = document.createElement('article'); card.className = 'journal-entry-card';
      const top = document.createElement('div'); top.className = 'journal-entry-top';
      const heading = document.createElement('div');
      const title = document.createElement('h3'); title.textContent = entry.title || journalDateLabel(entry.date, { month: 'long', day: 'numeric', year: 'numeric' });
      const time = document.createElement('time'); time.dateTime = entry.date; time.textContent = journalDateLabel(entry.date);
      heading.append(title, time); top.append(heading);
      const actions = document.createElement('div'); actions.className = 'journal-card-actions';
      [['edit', 'Edit'], ['delete', 'Delete']].forEach(([action, label]) => { const button = document.createElement('button'); button.type = 'button'; button.className = `button ${action === 'delete' ? 'delete-checkin' : 'secondary'}`; button.dataset.journalAction = action; button.dataset.journalId = entry.id; button.textContent = label; actions.append(button); });
      top.append(actions); card.append(top);
      const body = document.createElement('p'); body.className = 'journal-entry-body'; body.textContent = entry.body; card.append(body);
      if (entry.tags?.length) { const tags = document.createElement('div'); tags.className = 'journal-tags'; entry.tags.forEach((value) => { const chip = document.createElement('span'); chip.textContent = value; tags.append(chip); }); card.append(tags); }
      if (entry.moodId) { const linked = savedCheckins.find((item) => item.id === entry.moodId); const mood = document.createElement('p'); mood.className = 'journal-linked-mood'; mood.textContent = linked ? `Linked check-in · ${linked.mood} · ${dateLabel(linked.createdAt)}` : 'Linked check-in is no longer available'; card.append(mood); }
      list.append(card);
    });
    const empty = $('#journal-entries-empty'); const noResults = $('#journal-no-results');
    if (empty) empty.hidden = journalEntries.length > 0;
    if (noResults) noResults.hidden = journalEntries.length === 0 || filtered.length > 0;
    const count = $('#journal-results-count'); if (count) count.textContent = `${filtered.length} ${filtered.length === 1 ? 'entry' : 'entries'}${query || filterDate ? ' found' : ''}${filtered.length > journalVisibleLimit ? ` · showing ${journalVisibleLimit}` : ''}`;
    const loadMore = $('#journal-load-more'); if (loadMore) loadMore.hidden = filtered.length <= journalVisibleLimit;
    const clear = $('#journal-clear'); const exportButton = $('#journal-export');
    if (clear) clear.disabled = journalEntries.length === 0 || !journalStorageAvailable;
    if (exportButton) exportButton.disabled = journalEntries.length === 0;
  }

  function saveJournalEntries(next) {
    if (!journalStorageAvailable) return false;
    try { next.sort((a, b) => Date.parse(b.date) - Date.parse(a.date)); window.localStorage.setItem(JOURNAL_KEY, JSON.stringify(next)); journalEntries = next; journalVisibleLimit = JOURNAL_PAGE_SIZE; renderJournal(); renderRecommendations(currentCheckin); return true; }
    catch (_) { journalStorageAvailable = false; const status = $('#journal-status'); if (status) status.textContent = 'Browser storage is unavailable or full. Your changes were not saved.'; renderJournal(); return false; }
  }

  function resetJournalForm() {
    $('#journal-form')?.reset(); editingJournalId = null;
    const date = $('#journal-date'); if (date) date.value = localDateTimeValue();
    const save = $('#journal-save'); if (save) save.textContent = 'Save entry';
    const cancel = $('#journal-cancel'); if (cancel) cancel.hidden = true;
    const count = $('#journal-char-count'); if (count) count.textContent = '0 / 5,000';
    renderJournalMoodOptions('');
  }

  function editJournalEntry(id) {
    const entry = journalEntries.find((item) => item.id === id); if (!entry) return;
    editingJournalId = id;
    $('#journal-title-input').value = entry.title || ''; $('#journal-body').value = entry.body;
    $('#journal-date').value = localDateTimeValue(new Date(entry.date)); $('#journal-tags').value = (entry.tags || []).join(', ');
    renderJournalMoodOptions(entry.moodId || '');
    $('#journal-char-count').textContent = `${entry.body.length} / 5,000`;
    $('#journal-save').textContent = 'Save changes'; $('#journal-cancel').hidden = false;
    $('#journal-body').focus();
  }

  function initJournal() {
    try {
      const parsed = JSON.parse(window.localStorage.getItem(JOURNAL_KEY) || '[]');
      journalEntries = Array.isArray(parsed) ? parsed.filter((entry) => entry && typeof entry.id === 'string' && typeof entry.date === 'string' && Number.isFinite(Date.parse(entry.date)) && typeof entry.body === 'string' && Array.isArray(entry.tags)).slice(0, 10000).sort((a, b) => Date.parse(b.date) - Date.parse(a.date)) : [];
    } catch (_) { journalStorageAvailable = false; journalEntries = []; }
    const date = $('#journal-date'); if (date) date.value = localDateTimeValue();
    renderJournal();
    renderRecommendations(currentCheckin);
    renderInsightsDashboard();
    $('#journal-form')?.addEventListener('submit', (event) => {
      event.preventDefault();
      const body = $('#journal-body').value.trim(); const dateValue = new Date($('#journal-date').value);
      if (!body) { $('#journal-body').focus(); return; }
      if (Number.isNaN(dateValue.getTime())) { $('#journal-date').focus(); return; }
      const tags = [...new Set($('#journal-tags').value.split(',').map((tag) => tag.trim().replace(/^#/, '').slice(0, 32)).filter(Boolean))].slice(0, 12);
      const old = journalEntries.find((item) => item.id === editingJournalId);
      const entry = { id: old?.id || (window.crypto?.randomUUID ? crypto.randomUUID() : `${Date.now()}-${Math.random().toString(36).slice(2)}`), createdAt: old?.createdAt || new Date().toISOString(), updatedAt: new Date().toISOString(), date: dateValue.toISOString(), title: $('#journal-title-input').value.trim(), body, tags, moodId: $('#journal-mood').value || null };
      if (saveJournalEntries(old ? journalEntries.map((item) => item.id === old.id ? entry : item) : [entry, ...journalEntries])) { resetJournalForm(); $('#journal-status').textContent = 'Entry saved on this device.'; }
    });
    $('#journal-cancel')?.addEventListener('click', resetJournalForm);
    $('#journal-body')?.addEventListener('input', (event) => { $('#journal-char-count').textContent = `${event.currentTarget.value.length} / 5,000`; });
    $('#journal-search')?.addEventListener('input', () => { clearTimeout(journalSearchTimer); journalSearchTimer = window.setTimeout(() => { journalVisibleLimit = JOURNAL_PAGE_SIZE; renderJournal(); }, 150); });
    $('#journal-date-filter')?.addEventListener('change', () => { journalVisibleLimit = JOURNAL_PAGE_SIZE; renderJournal(); });
    $('#journal-load-more')?.addEventListener('click', () => { journalVisibleLimit += JOURNAL_PAGE_SIZE; renderJournal(); });
    $('#journal-entries')?.addEventListener('click', (event) => {
      const button = event.target.closest('[data-journal-action]'); if (!button) return;
      if (button.dataset.journalAction === 'edit') editJournalEntry(button.dataset.journalId);
      else if (button.dataset.journalAction === 'delete' && window.confirm('Delete this journal entry from this browser? This cannot be undone.')) {
        const next = journalEntries.filter((item) => item.id !== button.dataset.journalId);
        if (saveJournalEntries(next)) { if (editingJournalId === button.dataset.journalId) resetJournalForm(); $('#journal-status').textContent = 'Entry deleted from this device.'; }
      }
    });
    $('#journal-clear')?.addEventListener('click', () => {
      if (!journalEntries.length || !window.confirm('Delete all journal entries from this browser? This cannot be undone.')) return;
      if (saveJournalEntries([])) { resetJournalForm(); $('#journal-status').textContent = 'All journal entries deleted from this device.'; }
    });
    $('#journal-export')?.addEventListener('click', () => {
      if (!journalEntries.length) return;
      const blob = new Blob([JSON.stringify({ exportedAt: new Date().toISOString(), entries: journalEntries }, null, 2)], { type: 'application/json' });
      const url = URL.createObjectURL(blob); const anchor = document.createElement('a'); anchor.href = url; anchor.download = `mindful-journal-${dateKey(new Date())}.json`; anchor.click(); URL.revokeObjectURL(url);
    });
    const SpeechRecognition = window.SpeechRecognition || window.webkitSpeechRecognition;
    const voiceButton = $('#journal-voice'); const voiceStatus = $('#journal-voice-status');
    if (!SpeechRecognition) { if (voiceButton) voiceButton.disabled = true; if (voiceStatus) voiceStatus.textContent = 'Voice input is not supported here. You can type your reflection instead.'; }
    else voiceButton?.addEventListener('click', () => {
      if (!window.mindfulVoiceEnabled) { voiceStatus.textContent = 'Enable optional voice features in Settings first. You can type instead.'; return; }
      if (voiceButton.getAttribute('aria-pressed') === 'true') { journalRecognition?.stop(); return; }
      if (!$('#journal-speech-consent')?.checked) { voiceStatus.textContent = 'Give speech recognition consent before activating your microphone.'; return; }
      try {
        const instance = new SpeechRecognition(); journalRecognition = instance; instance.lang = navigator.language || 'en-US'; instance.continuous = false; instance.interimResults = true;
        const bodyField = $('#journal-body'); const prefix = bodyField.value ? `${bodyField.value} ` : '';
        voiceButton.setAttribute('aria-pressed', 'true'); voiceButton.textContent = 'Stop listening'; voiceStatus.textContent = 'Listening… your browser may process audio to provide transcription.';
        instance.onresult = (resultEvent) => { let text = ''; for (let i = 0; i < resultEvent.results.length; i += 1) text += resultEvent.results[i][0].transcript; bodyField.value = `${prefix}${text}`.slice(0, 5000); $('#journal-char-count').textContent = `${bodyField.value.length} / 5,000`; };
        instance.onerror = (errorEvent) => { voiceStatus.textContent = errorEvent.error === 'not-allowed' ? 'Microphone permission was not granted. You can type instead.' : 'Speech recognition stopped. You can continue typing.'; };
        instance.onend = () => { voiceButton.setAttribute('aria-pressed', 'false'); voiceButton.textContent = 'Speak reflection'; if (voiceStatus.textContent.startsWith('Listening')) voiceStatus.textContent = 'Transcription added to your draft. Review it before saving.'; };
        window.dispatchEvent(new Event('mindful:speech-input-start'));
        instance.start();
      } catch (_) { voiceStatus.textContent = 'Voice input could not start. You can type your reflection instead.'; voiceButton.setAttribute('aria-pressed', 'false'); }
    });
    if (voiceButton) voiceButton.disabled = !SpeechRecognition || !window.mindfulVoiceEnabled;
  }

  const supportedMoods = new Set(['Calm', 'Okay', 'Low', 'Anxious', 'Overwhelmed', 'Not sure']);
  const saveHistoryLabel = 'Save this check-in on this device to keep it in Mood History and Journal';

  function updateFinishButtonLabel() {
    const button = $('#finish');
    const saveToggle = $('#save-checkin-history');
    if (!button || isSubmitting) return;
    button.textContent = editingEntryId ? 'Save changes and view summary' : saveToggle?.checked ? 'Save check-in and view summary' : 'View summary without saving';
  }

  function setEditMode(entry = null) {
    editingEntryId = entry?.id || null;
    const notice = $('#edit-mode-notice');
    const cancelButton = $('#cancel-edit');
    const saveToggle = $('#save-checkin-history');
    const label = $('label[for="save-checkin-history"]');
    if (notice) notice.hidden = !entry;
    if (cancelButton) cancelButton.hidden = !entry;
    if (saveToggle) {
      saveToggle.checked = Boolean(entry);
      saveToggle.disabled = Boolean(entry) || !historyStorageAvailable;
    }
    if (label) label.textContent = !historyStorageAvailable
      ? 'Local history is unavailable in this browser'
      : entry ? 'This entry is already saved; Save changes will update it in place.' : saveHistoryLabel;
    updateFinishButtonLabel();
  }

  function resetCheckinForm({ focus = false, message = 'Ready for another check-in.' } = {}) {
    if (listening && recognition) recognition.stop();
    if (reflection) { reflection.value = ''; reflection.dataset.prior = ''; updateWordCount(); }
    const reflectionDetails = $('#reflection-details');
    if (reflectionDetails) reflectionDetails.open = false;
    if (speechStatus) setStatus(speechStatus, recognition
      ? 'Speech recognition is available in supported browsers.'
      : 'Speech recognition is not supported in this browser. You can type your reflection instead.');
    const moodButtons = $$('.mood', moodGroup || document);
    moodButtons.forEach((button, index) => {
      button.classList.remove('selected');
      button.setAttribute('aria-pressed', 'false');
      button.tabIndex = index === 0 ? 0 : -1;
    });
    if (moodSelectionStatus) moodSelectionStatus.textContent = 'Choose a mood, or leave it unselected.';
    if (intensity) intensity.value = '5';
    updateIntensity();
    const dashboard = $('#emotion-dashboard');
    if (dashboard) { dashboard.replaceChildren(); dashboard.hidden = true; }
    const analyzeVoice = $('#analyze-voice');
    if (analyzeVoice) analyzeVoice.checked = false;
    latestReport = null;
    currentCheckin = null;
    isSubmitting = false;
    setEditMode(null);
    const resultTitle = $('#result-heading');
    if (resultTitle) resultTitle.textContent = 'Your check-in summary';
    if (resultPanel) resultPanel.hidden = true;
    const finishButton = $('#finish');
    if (finishButton) { finishButton.disabled = false; finishButton.removeAttribute('aria-busy'); }
    const workflow = $('#check-in-panel');
    workflow?.removeAttribute('aria-busy');
    stopCamera();
    window.dispatchEvent(new Event('mindful:reset-checkin'));
    renderDashboard(null);
    setStatus(liveStatus, message);
    if (focus) {
      workflow?.scrollIntoView?.({ behavior: window.matchMedia('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth', block: 'start' });
      moodButtons[0]?.focus();
    }
  }

  function beginEditingCheckin(entryId) {
    const entry = savedCheckins.find((item) => item.id === entryId);
    if (!entry) { setStatus(liveStatus, 'That saved check-in is no longer available. Refresh your history and try again.'); return; }
    const moodButton = $$('.mood', moodGroup || document).find((button) => button.dataset.mood === entry.mood);
    if (!moodButton) { setStatus(liveStatus, 'This saved check-in has an unsupported mood value and cannot be edited.'); return; }
    currentCheckin = entry;
    latestReport = null;
    isSubmitting = false;
    resultPanel.hidden = true;
    $('#finish').disabled = false;
    moodButton.click();
    if (intensity) intensity.value = String(entry.intensity);
    updateIntensity();
    if (reflection) { reflection.value = entry.reflection; reflection.dataset.prior = entry.reflection ? entry.reflection + ' ' : ''; updateWordCount(); }
    if ($('#reflection-details') && entry.reflection) $('#reflection-details').open = true;
    const analyzeVoice = $('#analyze-voice');
    if (analyzeVoice) analyzeVoice.checked = false;
    const dashboard = $('#emotion-dashboard');
    if (dashboard) { dashboard.replaceChildren(); dashboard.hidden = true; }
    window.dispatchEvent(new Event('mindful:stop-camera'));
    setEditMode(entry);
    setStatus(liveStatus, 'Editing your saved ' + entry.mood.toLowerCase() + ' check-in. Save changes to update this entry.');
    $('#check-in-panel')?.scrollIntoView?.({ behavior: window.matchMedia('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth', block: 'start' });
    moodButton.focus();
  }

  async function deleteSavedCheckin(entryId) {
    const entry = savedCheckins.find((item) => item.id === entryId);
    if (!entry || !window.confirm('Delete this saved check-in from this browser? This cannot be undone.')) return;
    if (!historyStorageAvailable) { setStatus(liveStatus, 'Local history is unavailable, so this check-in could not be deleted.'); return; }
    const nextEntries = savedCheckins.filter((item) => item.id !== entryId);
    try { window.localStorage.setItem(HISTORY_KEY, JSON.stringify(nextEntries)); }
    catch (_) {
      historyStorageAvailable = false;
      renderDashboard(currentCheckin);
      setStatus(liveStatus, 'The saved check-in could not be deleted. Check browser storage and try again.');
      return;
    }
    savedCheckins = nextEntries;
    if (editingEntryId === entryId || currentCheckin?.id === entryId) resetCheckinForm({ message: 'Saved check-in deleted.' });
    else { renderDashboard(currentCheckin); setStatus(liveStatus, 'Saved check-in deleted.'); }
    $('#mood-history h2')?.focus({ preventScroll: true });
  }

  const saveToggle = $('#save-checkin-history');
  saveToggle?.addEventListener('change', updateFinishButtonLabel);
  $('#cancel-edit')?.addEventListener('click', () => resetCheckinForm({ focus: true, message: 'Editing canceled. Your saved check-in has not changed.' }));
  $('#skip-capture')?.addEventListener('click', () => {
    window.dispatchEvent(new Event('mindful:stop-camera'));
    setStatus(liveStatus, 'Camera and voice skipped. Choose a mood and intensity below to continue.');
    $('#check-in-panel')?.scrollIntoView?.({ behavior: window.matchMedia('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth', block: 'start' });
    $$('.mood', moodGroup || document)[0]?.focus();
  });
  $('#mood-history')?.addEventListener('click', (event) => {
    const button = event.target.closest('[data-entry-action]');
    if (button) {
      if (button.dataset.entryAction === 'edit') beginEditingCheckin(button.dataset.entryId);
      else if (button.dataset.entryAction === 'delete') deleteSavedCheckin(button.dataset.entryId);
      return;
    }
    const dayButton = event.target.closest('[data-history-date]');
    if (dayButton && !dayButton.disabled) {
      selectedHistoryDate = dayButton.dataset.historyDate;
      renderMoodHistory();
    }
  });
  $('#calendar-prev')?.addEventListener('click', () => { calendarMonth = new Date(calendarMonth.getFullYear(), calendarMonth.getMonth() - 1, 1); selectedHistoryDate = null; renderMoodHistory(); });
  $('#calendar-next')?.addEventListener('click', () => { calendarMonth = new Date(calendarMonth.getFullYear(), calendarMonth.getMonth() + 1, 1); selectedHistoryDate = null; renderMoodHistory(); });
  $('#history-range')?.addEventListener('change', (event) => { historyRange = event.currentTarget.value; renderMoodHistory(); });

  savedCheckins = readSavedCheckins();
  renderDashboard(null);
  initJournal();
  updateFinishButtonLabel();

  function setStatus(element, message, className) {
    if (!element) return;
    element.textContent = message;
    if (className) element.className = className;
  }

  function updateWordCount() {
    if (!reflection || !wordCount) return;
    reflection.value = reflection.value.slice(0, 500);
    wordCount.textContent = `${reflection.value.length} / 500`;
  }

  if (reflection && wordCount) {
    reflection.addEventListener('input', updateWordCount);
    updateWordCount();
  }

  const SpeechRecognition = window.SpeechRecognition || window.webkitSpeechRecognition;
  if (listenButton && reflection && speechStatus && SpeechRecognition) {
    try {
      recognition = new SpeechRecognition();
      recognition.lang = navigator.language || 'en-US';
      recognition.continuous = false;
      recognition.interimResults = true;
      recognition.onstart = () => {
        listening = true;
        listenButton.setAttribute('aria-pressed', 'true');
        const label = $('span:last-child', listenButton);
        if (label) label.textContent = 'Listening… click to stop';
        listenButton.classList.add('recording');
        setStatus(speechStatus, 'Listening. Speak naturally; your words will appear above.');
        speechStatus.classList.add('listening');
      };
      recognition.onresult = (event) => {
        let finalText = '';
        let interimText = '';
        for (let index = event.resultIndex || 0; index < event.results.length; index += 1) {
          const result = event.results[index];
          if (result.isFinal) finalText += `${result[0].transcript} `;
          else interimText += result[0].transcript;
        }
        const prior = reflection.dataset.prior || '';
        const committed = `${prior}${finalText}`.trim();
        reflection.value = `${committed}${interimText ? `${committed ? ' ' : ''}${interimText}` : ''}`.slice(0, 500);
        if (finalText) reflection.dataset.prior = committed ? `${committed} ` : '';
        updateWordCount();
      };
      recognition.onerror = (event) => {
        const message = event.error === 'not-allowed'
          ? 'Microphone permission was not granted. You can type your reflection instead.'
          : `Speech recognition stopped (${event.error}). You can type your reflection instead.`;
        setStatus(speechStatus, message);
      };
      recognition.onend = () => {
        listening = false;
        listenButton.setAttribute('aria-pressed', 'false');
        const label = $('span:last-child', listenButton);
        if (label) label.textContent = 'Speak my reflection';
        listenButton.classList.remove('recording');
        speechStatus.classList.remove('listening');
        reflection.dataset.prior = reflection.value.trim() ? `${reflection.value.trim()} ` : '';
      };
      listenButton.addEventListener('click', () => {
        if (listening) {
          recognition.stop();
          return;
        }
      if (!window.mindfulVoiceEnabled) { setStatus(speechStatus, 'Enable optional voice features in Settings first. You can type instead.'); return; }
      if (!$('#checkin-speech-consent')?.checked) { setStatus(speechStatus, 'Give speech recognition consent before activating your microphone.'); return; }
        reflection.dataset.prior = reflection.value.trim() ? `${reflection.value.trim()} ` : '';
        try {
          window.dispatchEvent(new Event('mindful:speech-input-start'));
          recognition.start();
        } catch (_) {
          setStatus(speechStatus, 'Speech recognition is starting. Please try again in a moment.');
        }
      });
    } catch (_) {
      recognition = null;
    }
  }
  if (listenButton && !recognition) {
    listenButton.disabled = true;
    listenButton.title = 'Speech recognition is not available in this browser.';
    setStatus(speechStatus, 'Speech recognition is not supported in this browser. You can type your reflection instead.');
  }

  if (moodGroup) {
    const moodButtons = $$('.mood', moodGroup);
    moodButtons.forEach((button, index) => {
      button.setAttribute('aria-pressed', 'false');
      button.tabIndex = index === 0 ? 0 : -1;
    });
    const selectMood = (button) => {
      moodButtons.forEach((item) => {
        const selected = item === button;
        item.classList.toggle('selected', selected);
        item.setAttribute('aria-pressed', String(selected));
        item.tabIndex = selected ? 0 : -1;
      });
      if (moodSelectionStatus) moodSelectionStatus.textContent = 'Selected mood: ' + button.dataset.mood + '.';
    };
    moodGroup.addEventListener('click', (event) => {
      const button = event.target.closest('.mood');
      if (button && moodGroup.contains(button)) selectMood(button);
    });
    moodGroup.addEventListener('keydown', (event) => {
      if (!['ArrowRight', 'ArrowDown', 'ArrowLeft', 'ArrowUp', 'Home', 'End'].includes(event.key)) return;
      const currentIndex = moodButtons.indexOf(document.activeElement);
      if (currentIndex < 0) return;
      event.preventDefault();
      const step = event.key === 'ArrowRight' || event.key === 'ArrowDown' ? 1 : -1;
      const nextIndex = event.key === 'Home' ? 0 : event.key === 'End' ? moodButtons.length - 1 : (currentIndex + step + moodButtons.length) % moodButtons.length;
      const next = moodButtons[nextIndex];
      next.focus();
      selectMood(next);
    });
  }

  function updateIntensity() {
    if (!intensity || !intensityValue) return;
    const value = Math.min(10, Math.max(1, Number(intensity.value) || 5));
    intensity.value = String(value);
    intensityValue.textContent = `${value} / 10`;
    intensity.setAttribute('aria-valuetext', `${value} out of 10`);
    const percent = ((value - 1) / 9) * 100;
    intensity.style.background = `linear-gradient(90deg,#6e9b7e 0%,#6e9b7e ${percent}%,#344239 ${percent}%)`;
  }
  intensity?.addEventListener('input', updateIntensity);
  intensity?.addEventListener('change', updateIntensity);
  updateIntensity();

  function stopCamera() {
    cameraStream?.getTracks().forEach((track) => track.stop());
    cameraStream = null;
    if (video) {
      video.srcObject = null;
      video.hidden = true;
    }
    const placeholder = cameraStage?.querySelector('.camera-placeholder');
    if (placeholder) placeholder.hidden = false;
    if (cameraButton) { cameraButton.innerHTML = '<span aria-hidden="true">◉</span> Open camera'; cameraButton.setAttribute('aria-pressed', 'false'); }
  }

  window.addEventListener('mindful:stop-camera', stopCamera);
  window.addEventListener('pagehide', stopCamera);
  cameraButton?.addEventListener('click', async () => {
    if (!video || !cameraStage) {
      setStatus(liveStatus, 'Camera preview is unavailable in this page.');
      return;
    }
    if (cameraStream) {
      stopCamera();
      setStatus(liveStatus, 'Camera is off.');
      return;
    }
    if (!navigator.mediaDevices?.getUserMedia) {
      setStatus(liveStatus, 'Camera access requires HTTPS or localhost and a supported browser.');
      return;
    }
    cameraButton.disabled = true;
    try {
      cameraStream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: 'user' }, audio: false });
      video.srcObject = cameraStream;
      video.hidden = false;
      const placeholder = cameraStage.querySelector('.camera-placeholder');
      if (placeholder) placeholder.hidden = true;
      cameraButton.innerHTML = '<span aria-hidden="true">◉</span> Turn off camera';
      cameraButton.setAttribute('aria-pressed', 'true');
      setStatus(liveStatus, 'Camera preview is on this device. It does not assess your face.');
    } catch (error) {
      stopCamera();
      const message = error?.name === 'NotAllowedError'
        ? 'Camera permission was not granted.'
        : error?.name === 'NotFoundError'
          ? 'No camera was found on this device.'
          : 'The camera could not be opened. Check browser permission and try again.';
      setStatus(liveStatus, message);
    } finally {
      cameraButton.disabled = false;
    }
  });

  helpButton?.addEventListener('click', () => {
    if (!helpMessage) {
      setStatus(liveStatus, 'This is a self-reflection tool. Voice matching is experimental and cannot diagnose mental health.');
      return;
    }
    helpMessage.hidden = !helpMessage.hidden;
    helpButton.setAttribute('aria-expanded', String(!helpMessage.hidden));
  });

  const guidance = {
    Calm: 'Notice what is helping and make room for it. Consider a restorative activity or time with someone you trust.',
    Okay: 'Choose one manageable activity that supports your wellbeing, and take it at your own pace.',
    Low: 'Try one gentle step such as water, daylight, rest, or telling someone you trust how you are doing. If this continues to weigh on you, consider speaking with a qualified professional.',
    Anxious: 'Try slowing your breathing and naming a few things you can see and feel. If useful, share what is worrying you with someone you trust.',
    Overwhelmed: 'You do not need to solve everything at once. Pick one small next step and ask someone you trust for support if you need it.',
    'Not sure': 'It is okay not to have a label. Pause, notice what you need physically, and consider checking in with yourself again later.'
  };

  function recommendationFor(mood, level) {
    const base = mood ? guidance[mood] : 'Take a short pause and choose one small supportive next step.';
    return level >= 8
      ? `${base} You rated this feeling as very intense. Consider reaching out to someone you trust for support now.`
      : base;
  }

  function saveCurrentCheckin(entry) {
    if (!historyStorageAvailable) return { saved: false, error: 'Local history is unavailable. This check-in was not saved.' };
    if (editingEntryId) {
      const previous = savedCheckins.find((item) => item.id === editingEntryId);
      if (!previous) return { saved: false, error: 'This saved entry no longer exists. Refresh history before trying again.' };
      const record = { id: previous.id, createdAt: previous.createdAt, mood: entry.mood, intensity: Number(entry.intensity), reflection: entry.reflection, updatedAt: new Date().toISOString() };
      const nextEntries = savedCheckins.map((item) => item.id === editingEntryId ? record : item);
      try { window.localStorage.setItem(HISTORY_KEY, JSON.stringify(nextEntries)); }
      catch (_) { historyStorageAvailable = false; return { saved: false, error: 'Changes could not be saved. Check browser storage and try again.' }; }
      savedCheckins = nextEntries;
      return { saved: true, updated: true, record };
    }
    const saveToggle = $('#save-checkin-history');
    if (!saveToggle?.checked) return { saved: false };
    const record = {
      id: Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 10),
      createdAt: entry.createdAt,
      mood: entry.mood,
      intensity: Number(entry.intensity),
      reflection: entry.reflection
    };
    const nextEntries = [record, ...savedCheckins].slice(0, 100);
    try { window.localStorage.setItem(HISTORY_KEY, JSON.stringify(nextEntries)); }
    catch (_) { historyStorageAvailable = false; return { saved: false, error: 'Local storage is full or unavailable. This check-in was not saved.' }; }
    savedCheckins = nextEntries;
    return { saved: true, updated: false, record };
  }

  $('#clear-checkin-history')?.addEventListener('click', () => {
    if (!savedCheckins.length) return;
    if (!window.confirm('Clear saved mood and journal history from this browser?')) return;
    const hadSavedDraft = Boolean(editingEntryId || currentCheckin?.id);
    try {
      window.localStorage.removeItem(HISTORY_KEY);
      savedCheckins = [];
      if (hadSavedDraft) resetCheckinForm({ message: 'Saved history cleared. Your check-in form is ready.' });
      else { currentCheckin = null; renderDashboard(null); }
      setStatus(liveStatus, 'Saved check-in history was cleared from this browser.');
      $('#mood-history h2')?.focus({ preventScroll: true });
    } catch (_) {
      historyStorageAvailable = false;
      renderDashboard(currentCheckin);
      setStatus(liveStatus, 'Saved history could not be cleared. Check browser storage settings.');
    }
  });

  const ACTIVITIES = [
    { id: 'guided-breathing', title: 'Guided breathing', icon: '◉', category: 'BREATHE', minutes: 2, description: 'Follow a gentle rhythm with an expanding and softening circle. Keep each breath easy and natural.', steps: ['Settle into a comfortable position.', 'Breathe in gently as the circle grows.', 'Breathe out comfortably as it softens.', 'Let your own pace guide you; skip any breath hold that feels uncomfortable.'], phases: [{ label: 'Breathe in', seconds: 4, style: 'inhale' }, { label: 'Breathe out', seconds: 6, style: 'exhale' }] },
    { id: 'box-breathing', title: 'Box breathing', icon: '▢', category: 'BREATHE', minutes: 2, description: 'Explore a balanced four-part breathing pattern. Breath holds are optional; keep breathing normally whenever you prefer.', steps: ['Breathe in gently for a count of four.', 'Pause comfortably for four, or breathe through this part.', 'Breathe out gently for four.', 'Pause comfortably for four, or breathe through this part.'], phases: [{ label: 'Breathe in', seconds: 4, style: 'inhale' }, { label: 'Pause (optional)', seconds: 4, style: 'hold' }, { label: 'Breathe out', seconds: 4, style: 'exhale' }, { label: 'Pause (optional)', seconds: 4, style: 'hold' }] },
    { id: 'meditation', title: 'Short meditation', icon: '☼', category: 'PAUSE', minutes: 3, description: 'Take a few quiet minutes to notice the present moment, without needing to change anything.', steps: ['Let your eyes rest open or closed, whichever feels comfortable.', 'Notice one or two natural breaths.', 'When attention wanders, gently return to a sound, sensation, or breath.', 'There is no special state to reach; simply noticing is enough.'] },
    { id: 'gratitude', title: 'Gratitude practice', icon: '✿', category: 'REFLECT', minutes: 2, description: 'Notice small or meaningful things you appreciate. Your answers can be complicated, brief, or private.', steps: ['Think of one thing from today you appreciated.', 'Notice why it mattered to you.', 'If you like, name another small moment or person.', 'Let your reflection be your own; there is no right answer.'], prompt: 'What is one thing you appreciated today?' },
    { id: 'daily-reflection', title: 'Daily reflection', icon: '⌁', category: 'REFLECT', minutes: 3, description: 'Make room to notice how your day has felt and what you might need next.', steps: ['Recall one moment from today that stands out.', 'Notice how you felt in that moment.', 'Consider what supported you, or what you may need now.', 'You can write a few words or simply reflect quietly.'], prompt: 'What moment from today would you like to remember?' },
    { id: 'relaxation', title: 'Relaxation exercise', icon: '≈', category: 'UNWIND', minutes: 3, description: 'Take a gentle pause to notice places that feel at ease. There is no need to force your body to relax.', steps: ['Find a position that feels supported, if possible.', 'Notice the contact of your feet, hands, or back with a surface.', 'Let your shoulders or jaw soften only if that feels comfortable.', 'Take a natural breath and notice one sound around you.'] },
    { id: 'self-reflection', title: 'Positive self-reflection', icon: '♡', category: 'REFLECT', minutes: 2, description: 'Recognize a small effort, quality, or choice of yours with the same kindness you might offer another person.', steps: ['Recall something you handled or tried, however small.', 'Notice what personal quality or effort helped.', 'Offer yourself a kind, realistic acknowledgment.', 'You do not need to feel positive; simple recognition is enough.'], prompt: 'What is one effort or quality you can acknowledge in yourself?' },
    { id: 'mindful-break', title: 'Short mindful break', icon: '✧', category: 'RESET', minutes: 1, description: 'A brief pause to reconnect with what is around you before continuing your day.', steps: ['Notice one thing you can see.', 'Notice one sound nearby.', 'Feel your feet or hands for a moment.', 'Choose one small next step, or simply continue when ready.'] }
  ];
  const ACTIVITY_KEY = storageKey('wellness-completions-v1');
  let selectedActivity = null;
  let activityInterval = null;
  let activityEndsAt = 0;
  let activityRemaining = 120000;
  let activityRunning = false;
  let activityPhaseElapsed = 0;
  const reducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;

  function renderActivityCards() {
    const grid = $('#activity-grid'); if (!grid) return;
    grid.replaceChildren(...ACTIVITIES.map((activity) => {
      const button = document.createElement('button'); button.type = 'button'; button.className = 'activity-card'; button.dataset.activityId = activity.id; button.setAttribute('aria-label', `${activity.title}, about ${activity.minutes} minutes`);
      const icon = document.createElement('span'); icon.className = 'activity-card-icon'; icon.setAttribute('aria-hidden', 'true'); icon.textContent = activity.icon;
      const meta = document.createElement('span'); meta.className = 'activity-card-meta'; meta.textContent = `${activity.category} · ${activity.minutes} MIN`;
      const title = document.createElement('strong'); title.textContent = activity.title;
      const description = document.createElement('span'); description.className = 'activity-card-description'; description.textContent = activity.description;
      const link = document.createElement('span'); link.className = 'activity-card-link'; link.textContent = 'Choose this activity →';
      button.append(icon, meta, title, description, link); return button;
    }));
  }

  function renderSavedActivities() {
    const list = $('#activity-saved-list'); const clear = $('#activity-clear-saved'); if (!list) return;
    list.replaceChildren();
    if (!savedActivities.length) { const empty = document.createElement('p'); empty.className = 'empty-inline'; empty.textContent = 'Completed activities you choose to save will appear here.'; list.append(empty); }
    savedActivities.slice().sort((a, b) => Date.parse(b.completedAt) - Date.parse(a.completedAt)).slice(0, 20).forEach((item) => {
      const row = document.createElement('div'); row.className = 'activity-saved-row';
      const title = document.createElement('strong'); title.textContent = item.title;
      const date = document.createElement('time'); date.dateTime = item.completedAt; date.textContent = journalDateLabel(item.completedAt, { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });
      row.append(title, date); list.append(row);
    });
    if (clear) clear.disabled = !savedActivities.length;
  }

  function loadSavedActivities() {
    try { const parsed = JSON.parse(window.localStorage.getItem(ACTIVITY_KEY) || '[]'); savedActivities = Array.isArray(parsed) ? parsed.filter((item) => item && typeof item.title === 'string' && typeof item.completedAt === 'string').slice(0, 100) : []; }
    catch (_) { savedActivities = []; }
    renderSavedActivities();
    renderInsightsDashboard();
  }

  function formatActivityTime(milliseconds) {
    const seconds = Math.max(0, Math.ceil(milliseconds / 1000));
    return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, '0')}`;
  }

  function updateActivityBreath(elapsed) {
    if (!selectedActivity?.phases) return;
    const phases = selectedActivity.phases;
    const cycleMs = phases.reduce((sum, phase) => sum + phase.seconds * 1000, 0);
    const withinCycle = elapsed % cycleMs;
    let total = 0; let current = phases[0];
    for (const phase of phases) { total += phase.seconds * 1000; if (withinCycle < total) { current = phase; break; } }
    $('#activity-phase').textContent = `${current.label} gently`;
    $('#activity-breathing-label').textContent = current.label;
    const orb = $('#activity-breathing-orb'); orb.classList.remove('inhale', 'exhale', 'hold'); orb.classList.add(current.style);
    orb.style.transitionDuration = reducedMotion ? '0ms' : `${current.seconds}s`;
  }

  function setActivityControls(state) {
    const start = $('#activity-start'); const pause = $('#activity-pause'); const finish = $('#activity-finish');
    if (start) { start.hidden = state !== 'ready'; start.textContent = 'Start'; }
    if (pause) { pause.hidden = state !== 'running' && state !== 'paused'; pause.textContent = state === 'paused' ? 'Resume' : 'Pause'; }
    if (finish) finish.hidden = state !== 'running' && state !== 'paused';
    if ($('#activity-duration')) $('#activity-duration').disabled = state !== 'ready';
    if ($('#activity-save-check')) $('#activity-save-check').disabled = state !== 'ready';
  }

  function selectActivity(id) {
    const activity = ACTIVITIES.find((item) => item.id === id); if (!activity) return;
    pauseActivity(false); selectedActivity = activity;
    $('#activity-session').hidden = false;
    $('#activity-session-title').textContent = activity.title; $('#activity-description').textContent = activity.description;
    const instructions = $('#activity-instructions'); instructions.replaceChildren(...activity.steps.map((step) => { const li = document.createElement('li'); li.textContent = step; return li; }));
    const writingWrap = $('#activity-writing-wrap'); writingWrap.hidden = !activity.prompt;
    $('#activity-prompt-label').textContent = activity.prompt || ''; $('#activity-writing').value = '';
    const breathing = $('#activity-breathing-visual'); breathing.hidden = !activity.phases;
    $('#activity-duration').value = String(activity.minutes * 60);
    activityRemaining = activity.minutes * 60000; activityPhaseElapsed = 0;
    $('#activity-time').textContent = formatActivityTime(activityRemaining); $('#activity-phase').textContent = 'Ready when you are';
    $('#activity-breathing-orb').classList.remove('inhale', 'exhale', 'hold');
    $('#activity-completion').hidden = true; $('#activity-status').textContent = 'No sound will play. Start when you’re ready.';
    $('#activity-save-check').checked = false; setActivityControls('ready');
    $('#activity-session').scrollIntoView?.({ behavior: reducedMotion ? 'auto' : 'smooth', block: 'nearest' });
    $('#activity-session-title').focus({ preventScroll: true });
  }

  function pauseActivity(preserve = true) {
    if (!activityRunning) return;
    activityRemaining = Math.max(0, activityEndsAt - Date.now()); activityRunning = false; clearInterval(activityInterval); activityInterval = null;
    if (preserve) { $('#activity-phase').textContent = 'Paused'; $('#activity-status').textContent = 'Take your time. Resume whenever you’re ready, or finish the activity.'; setActivityControls('paused'); }
  }

  function completeActivity(message = 'You made space for this moment.') {
    if (!selectedActivity) return;
    if (activityRunning) pauseActivity(false);
    clearInterval(activityInterval); activityInterval = null; activityRunning = false;
    $('#activity-time').textContent = '0:00'; $('#activity-phase').textContent = 'Complete';
    $('#activity-breathing-orb').classList.remove('inhale', 'exhale', 'hold');
    $('#activity-completion-detail').textContent = `${selectedActivity.title} · ${new Intl.DateTimeFormat(undefined, { hour: 'numeric', minute: '2-digit' }).format(new Date())}`;
    $('#activity-completion').hidden = false; $('#activity-status').textContent = message;
    setActivityControls('complete');
    if ($('#activity-save-check').checked) {
      const record = { id: Date.now().toString(36), title: selectedActivity.title, completedAt: new Date().toISOString() };
      try { const next = [record, ...savedActivities].slice(0, 100); window.localStorage.setItem(ACTIVITY_KEY, JSON.stringify(next)); savedActivities = next; renderSavedActivities(); renderInsightsDashboard(); }
      catch (_) { $('#activity-status').textContent = 'This activity is complete, but browser storage was unavailable so it could not be saved.'; }
    }
  }

  function tickActivity() {
    const elapsed = activityEndsAt - Date.now(); activityRemaining = Math.max(0, elapsed);
    $('#activity-time').textContent = formatActivityTime(activityRemaining);
    const spent = Math.max(0, Number($('#activity-duration').value) * 1000 - activityRemaining);
    if (selectedActivity?.phases) updateActivityBreath(spent);
    if (activityRemaining <= 0) completeActivity('Your chosen time is complete. Take a moment to notice how you feel before continuing.');
  }

  function startActivity() {
    if (!selectedActivity || activityRunning) return;
    if ($('#activity-time').textContent === '0:00') activityRemaining = Number($('#activity-duration').value) * 1000;
    if (activityRemaining <= 0) activityRemaining = Number($('#activity-duration').value) * 1000;
    activityEndsAt = Date.now() + activityRemaining; activityRunning = true;
    $('#activity-status').textContent = 'Go at a comfortable pace. Finish whenever you like.';
    $('#activity-completion').hidden = true; setActivityControls('running');
    tickActivity(); if (activityRunning) activityInterval = window.setInterval(tickActivity, 250);
  }

  renderActivityCards(); loadSavedActivities();
  $('#activity-grid')?.addEventListener('click', (event) => { const button = event.target.closest('[data-activity-id]'); if (button) selectActivity(button.dataset.activityId); });
  $('#activity-duration')?.addEventListener('change', (event) => { activityRemaining = Number(event.currentTarget.value) * 1000; $('#activity-time').textContent = formatActivityTime(activityRemaining); });
  $('#activity-start')?.addEventListener('click', startActivity);
  $('#activity-pause')?.addEventListener('click', () => { if (activityRunning) pauseActivity(); else if (selectedActivity) startActivity(); });
  $('#activity-finish')?.addEventListener('click', () => completeActivity('You finished whenever it felt right. Thank yourself for taking this time.'));
  $('#activity-done')?.addEventListener('click', () => { pauseActivity(false); selectedActivity = null; $('#activity-session').hidden = true; });
  $('#activity-close')?.addEventListener('click', () => { if (activityRunning) pauseActivity(); selectedActivity = null; $('#activity-session').hidden = true; });
  $('#activity-clear-saved')?.addEventListener('click', () => { if (!savedActivities.length || !window.confirm('Clear saved activity completions from this device?')) return; try { window.localStorage.removeItem(ACTIVITY_KEY); savedActivities = []; renderSavedActivities(); renderInsightsDashboard(); } catch (_) { setStatus($('#activity-status'), 'Saved activities could not be cleared. Check browser storage settings and try again.'); } });
  window.addEventListener('pagehide', () => { if (activityRunning) pauseActivity(false); });
  window.addEventListener('mindful:view-hidden', () => { if (activityRunning) pauseActivity(); });

  const reportEscape = (value) => String(value ?? '').replace(/[&<>"']/g, (character) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[character]);
  const reportDate = (value) => {
    const date = value instanceof Date ? value : new Date(value);
    return Number.isNaN(date.getTime()) ? 'Date unavailable' : date.toLocaleDateString(undefined, { year: 'numeric', month: 'long', day: 'numeric' });
  };
  function setReportDateDefaults() {
    const today = dateKey(new Date()); const start = new Date(); start.setDate(start.getDate() - 29);
    const startInput = $('#report-start-date'); const endInput = $('#report-end-date');
    if (startInput && !startInput.value) startInput.value = dateKey(start);
    if (endInput && !endInput.value) endInput.value = today;
    if (endInput) endInput.max = today;
  }
  setReportDateDefaults();

  function getSelectedReportData() {
    const start = $('#report-start-date')?.value;
    const end = $('#report-end-date')?.value;
    const includeMoods = Boolean($('#report-include-moods')?.checked);
    const includeJournal = Boolean($('#report-include-journal')?.checked);
    const includeActivities = Boolean($('#report-include-activities')?.checked);
    const includeCharts = Boolean($('#report-include-charts')?.checked);
    if (!start || !end || start > end) return { error: 'Choose a valid reporting period. The start date must be on or before the end date.' };
    if (!includeMoods && !includeJournal && !includeActivities) return { error: 'Choose at least one type of saved data to include.' };
    const within = (value) => {
      if (!value || !Number.isFinite(Date.parse(value))) return false;
      const day = dateKey(new Date(value));
      return day >= start && day <= end;
    };
    return {
      start, end, includeMoods, includeJournal, includeActivities, includeCharts,
      moods: includeMoods ? savedCheckins.filter((entry) => within(entry.createdAt)).sort((a, b) => Date.parse(a.createdAt) - Date.parse(b.createdAt)) : [],
      journals: includeJournal ? journalEntries.filter((entry) => within(entry.date)).sort((a, b) => Date.parse(a.date) - Date.parse(b.date)) : [],
      activities: includeActivities ? savedActivities.filter((entry) => within(entry.completedAt)).sort((a, b) => Date.parse(a.completedAt) - Date.parse(b.completedAt)) : []
    };
  }

  function makeReportChart(title, values) {
    const max = Math.max(1, ...values.map((item) => item.count));
    return `<section class="report-chart"><h3>${reportEscape(title)}</h3>${values.length ? values.map((item) => `<div class="chart-row"><span>${reportEscape(item.label)}</span><span class="chart-track"><i style="width:${Math.max(0, Math.min(100, item.count / max * 100))}%"></i></span><strong>${item.count}</strong></div>`).join('') : '<p>No saved data for this chart in the selected period.</p>'}</section>`;
  }

  function createReportDocument(data) {
    const generatedAt = new Date();
    const moodCounts = new Map(); data.moods.forEach((entry) => moodCounts.set(entry.mood, (moodCounts.get(entry.mood) || 0) + 1));
    const moodRows = [...moodCounts.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));
    const intensityValues = data.moods.map((entry) => Number(entry.intensity)).filter((value) => Number.isFinite(value) && value >= 1 && value <= 10);
    const recordedDays = new Set(data.moods.map((entry) => dateKey(new Date(entry.createdAt)))).size;
    const averageIntensity = intensityValues.length ? (intensityValues.reduce((sum, value) => sum + value, 0) / intensityValues.length).toFixed(1) : null;
    const sections = [];

    if (data.includeMoods) {
      const frequencyRows = moodRows.length ? `<table><thead><tr><th scope="col">Self-reported mood</th><th scope="col">Check-ins</th><th scope="col">Share of included check-ins</th></tr></thead><tbody>${moodRows.map(([mood, count]) => `<tr><td>${reportEscape(mood)}</td><td>${count}</td><td>${(count / data.moods.length * 100).toFixed(1)}%</td></tr>`).join('')}</tbody></table>` : '<p class="empty-report">No saved mood check-ins in this period. A mood summary is not available.</p>';
      const intensitySummary = intensityValues.length ? `<div class="stat-grid"><div><strong>${averageIntensity}/10</strong><span>Average intensity</span></div><div><strong>${Math.min(...intensityValues)} to ${Math.max(...intensityValues)} / 10</strong><span>Observed range</span></div><div><strong>${intensityValues.length}</strong><span>Intensity records</span></div></div><p class="muted">Intensity is the number you selected from 1 to 10. This is a descriptive summary, not an interpretation.</p>` : '<p class="empty-report">No valid saved intensity values are available for this period.</p>';
      const moodChart = data.includeCharts ? makeReportChart('Mood frequency', moodRows.map(([label, count]) => ({ label, count }))) : '';
      const intensityBins = Array.from({ length: 10 }, (_, index) => ({ label: String(index + 1), count: intensityValues.filter((value) => value === index + 1).length }));
      const intensityChart = data.includeCharts ? makeReportChart('Intensity values (1-10)', intensityBins) : '';
      sections.push(`<section class="report-section"><p class="eyebrow">MOOD CHECK-INS</p><h2>Check-in summary</h2><div class="stat-grid"><div><strong>${data.moods.length}</strong><span>Saved check-ins</span></div><div><strong>${recordedDays}</strong><span>Days with a check-in</span></div><div><strong>${intensityValues.length}</strong><span>Valid intensity values</span></div></div><h3>Mood frequency</h3>${frequencyRows}<h3>Mood intensity overview</h3>${intensitySummary}${moodChart}${intensityChart}</section>`);
    }

    if (data.includeJournal) {
      const checkinById = new Map((data.includeMoods ? data.moods : []).map((item) => [item.id, item]));
      const journalItems = data.journals.length ? data.journals.map((entry) => {
        const linked = entry.moodId ? checkinById.get(entry.moodId) : null;
        const tags = Array.isArray(entry.tags) && entry.tags.length ? `<p class="tags">Tags: ${reportEscape(entry.tags.join(', '))}</p>` : '';
        const body = String(entry.body || '').replace(/\r\n?/g, '\n');
        return `<article class="journal-entry"><h3>${reportEscape(entry.title || 'Reflection')}</h3><p class="muted">${reportEscape(reportDate(entry.date))}${linked ? ` · Linked mood check-in: ${reportEscape(linked.mood)}` : ''}</p>${tags}<p class="journal-body">${reportEscape(body).replace(/\n/g, '<br>')}</p></article>`;
      }).join('') : '<p class="empty-report">No saved journal entries in this period.</p>';
      sections.push(`<section class="report-section"><p class="eyebrow">JOURNAL</p><h2>Journal activity</h2><p>${data.journals.length} saved ${data.journals.length === 1 ? 'entry' : 'entries'} in the selected period. Entry text is included because you selected journal content.</p>${journalItems}</section>`);
    }

    if (data.includeActivities) {
      const counts = new Map(); data.activities.forEach((entry) => counts.set(entry.title, (counts.get(entry.title) || 0) + 1));
      const rows = [...counts.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));
      const table = rows.length ? `<table><thead><tr><th scope="col">Wellness activity</th><th scope="col">Saved completions</th></tr></thead><tbody>${rows.map(([title, count]) => `<tr><td>${reportEscape(title)}</td><td>${count}</td></tr>`).join('')}</tbody></table>` : '<p class="empty-report">No saved wellness activity completions in this period.</p>';
      const chart = data.includeCharts ? makeReportChart('Saved activity completions', rows.map(([label, count]) => ({ label, count }))) : '';
      sections.push(`<section class="report-section"><p class="eyebrow">WELLNESS ACTIVITIES</p><h2>Activity summary</h2><p>${data.activities.length} saved ${data.activities.length === 1 ? 'completion' : 'completions'} in the selected period.</p>${table}${chart}</section>`);
    }

    const style = `:root{font-family:"Aptos","Segoe UI",system-ui,sans-serif;color:#24372e;background:#eef2ee;font-size:14px;line-height:1.55}*{box-sizing:border-box}body{margin:0}.toolbar{position:sticky;top:0;z-index:2;display:flex;justify-content:center;gap:12px;padding:12px;background:#173d2b;color:#fff}.toolbar button{border:0;border-radius:8px;padding:10px 16px;background:#fff;color:#173d2b;font:600 14px "Segoe UI",sans-serif;cursor:pointer}.toolbar p{margin:0;align-self:center;font-size:12px}.report{max-width:880px;margin:24px auto;padding:44px 54px;background:white;box-shadow:0 10px 35px #1c322018}.brand{font-size:11px;font-weight:800;letter-spacing:.14em;color:#397050}.report h1{font-size:34px;line-height:1.12;letter-spacing:-.04em;margin:14px 0 8px}.period{font-size:16px;color:#5c6a61;margin:0}.generated{font-size:11px;color:#718078;margin:10px 0 24px}.notice{border-left:3px solid #83a68d;padding:10px 14px;background:#f3f7f3;font-size:11px;color:#506257;overflow-wrap:anywhere}.report-section{margin:32px 0;break-inside:auto}.report-section h2{font-size:21px;margin:4px 0 16px;break-after:avoid}.report-section h3{font-size:14px;margin:22px 0 9px;break-after:avoid}.eyebrow{font-size:10px;letter-spacing:.12em;color:#687b6e;font-weight:700;margin:0}.stat-grid{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:10px;margin:16px 0}.stat-grid>div{padding:14px;border:1px solid #dfe7df;border-radius:9px;break-inside:avoid}.stat-grid strong{display:block;font-size:20px;color:#28563c}.stat-grid span{font-size:10px;color:#65746a}table{width:100%;border-collapse:collapse;font-size:12px;margin:8px 0 18px}th,td{text-align:left;padding:9px 8px;border-bottom:1px solid #e3e9e3;vertical-align:top;overflow-wrap:anywhere}th{font-size:10px;color:#5b6d61;background:#f6f8f6}.muted{color:#68776d;font-size:11px}.empty-report{padding:14px;border-radius:8px;background:#f5f7f5;color:#56675d;font-size:12px}.report-chart{margin:18px 0;padding:13px;border:1px solid #e1e8e1;border-radius:9px;break-inside:avoid}.report-chart h3{margin:0 0 10px}.chart-row{display:grid;grid-template-columns:minmax(90px,1fr) minmax(80px,2fr) 32px;align-items:center;gap:9px;margin:6px 0;font-size:10px}.chart-row>span:first-child{overflow-wrap:anywhere}.chart-track{height:9px;border-radius:9px;background:#edf1ed;overflow:hidden}.chart-track i{display:block;height:100%;border-radius:inherit;background:#4e8060}.chart-row strong{text-align:right;font-variant-numeric:tabular-nums}.journal-entry{padding:14px 0;border-bottom:1px solid #e2e8e2;break-inside:auto}.journal-entry h3{margin:0 0 3px}.journal-entry .muted,.journal-entry .tags{margin:3px 0}.tags{color:#597363;font-size:10px}.journal-body{white-space:normal;overflow-wrap:anywhere;word-break:break-word;margin:10px 0 0;font-size:12px;line-height:1.65}.privacy-footer{margin-top:32px;padding-top:14px;border-top:1px solid #dfe6df;color:#67756c;font-size:10px;overflow-wrap:anywhere}@page{size:A4;margin:18mm 15mm 21mm 15mm;@top-left{content:"MINDFUL  |  PRIVATE WELLBEING REPORT";font:700 8pt "Segoe UI",sans-serif;color:#597363}@top-right{content:"Personal report";font:8pt "Segoe UI",sans-serif;color:#718078}@bottom-left{content:"Private document - save or share carefully";font:8pt "Segoe UI",sans-serif;color:#718078}@bottom-right{content:"Page " counter(page) " of " counter(pages);font:8pt "Segoe UI",sans-serif;color:#718078}}@media(max-width:640px){.report{margin:0;padding:26px 18px;box-shadow:none}.report h1{font-size:28px}.stat-grid{grid-template-columns:1fr}.toolbar{position:relative;flex-wrap:wrap}.chart-row{grid-template-columns:minmax(70px,1fr) minmax(55px,2fr) 26px}}@media print{html{background:white;font-size:10pt}.toolbar{display:none}.report{max-width:none;margin:0;padding:0;box-shadow:none}.report-section{margin:22px 0}.journal-entry{orphans:3;widows:3}.journal-body{orphans:3;widows:3}a{color:inherit;text-decoration:none}*{-webkit-print-color-adjust:exact;print-color-adjust:exact}}`;
    return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><meta name="color-scheme" content="light"><title>Mindful - Personal Wellbeing Report</title><style>${style}</style></head><body><div class="toolbar"><button type="button" onclick="window.print()">Print / save as PDF</button><p>In the print dialog, choose Save as PDF. This report is prepared locally.</p></div><main class="report"><div class="brand">MINDFUL</div><h1>Personal wellbeing report</h1><p class="period">${reportEscape(reportDate(`${data.start}T12:00:00`))} to ${reportEscape(reportDate(`${data.end}T12:00:00`))}</p><p class="generated">Generated ${reportEscape(generatedAt.toLocaleString())}</p><div class="notice"><strong>Privacy notice</strong><br>This report was assembled from saved records in this browser and was not uploaded by Mindful. Journal text appears only because you chose to include it. Voice recordings are excluded. The report may contain personal wellbeing information; keep it private.</div>${sections.join('')}<footer class="privacy-footer">Mindful provides personal reflection summaries, not clinical assessments or diagnoses. No cause, correlation, or clinical interpretation is inferred from these records.</footer></main></body></html>`;
  }

  function openPreparedReport() {
    const status = $('#report-builder-status');
    const data = getSelectedReportData();
    if (data.error) { if (status) status.textContent = data.error; return; }
    const reportWindow = window.open('', '_blank');
    if (!reportWindow) { if (status) status.textContent = 'Your browser blocked the report preview. Allow pop-ups for Mindful and try again.'; return; }
    reportWindow.opener = null;
    reportWindow.document.open();
    reportWindow.document.write(createReportDocument(data));
    reportWindow.document.close();
    if (status) status.textContent = 'Report preview opened. Choose Print / save as PDF, then select Save as PDF in your browser print dialog.';
  }

  $('#generate-wellbeing-report')?.addEventListener('click', openPreparedReport);
  $('#download-report')?.addEventListener('click', () => {
    const reportSection = $('#report-builder');
    reportSection?.scrollIntoView({ behavior: window.matchMedia('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth', block: 'center' });
    $('#report-start-date')?.focus({ preventScroll: true });
    const status = $('#report-builder-status');
    if (status) status.textContent = 'Choose the dates and which saved data to include, then prepare your report.';
  });

  function buildReport() {
    const selectedMood = $('.mood.selected', moodGroup || document)?.dataset.mood || '';
    const level = Number(intensity?.value);
    const reflectionText = reflection?.value.trim() || '';
    if (!supportedMoods.has(selectedMood)) return { error: 'Choose how you feel to continue. Not sure is always an option.' };
    if (!Number.isInteger(level) || level < 1 || level > 10) return { error: 'Choose an intensity from 1 to 10 before completing your check-in.' };
    if (reflectionText.length > 500) return { error: 'Keep your optional reflection to 500 characters or fewer.' };
    const recommendation = recommendationFor(selectedMood, level);
    const estimate = $('#emotion-dashboard strong')?.textContent?.trim() || 'Not recorded';
    const date = new Date().toLocaleString();
    return {
      report: { selfReportedMood: selectedMood, selfReportedIntensity: level, recommendation, date, voiceEstimate: estimate },
      summary: 'You reported feeling ' + selectedMood.toLowerCase() + ' with an intensity of ' + level + ' out of 10.'
    };
  }

  const finishButton = $('#finish');
  finishButton?.addEventListener('click', async () => {
    if (isSubmitting || finishButton.disabled) return;
    if (!resultPanel) { setStatus(liveStatus, 'The summary panel is unavailable. Please reload the page and try again.'); return; }
    const validation = buildReport();
    if (validation.error) {
      setStatus(liveStatus, validation.error);
      if (!supportedMoods.has($('.mood.selected', moodGroup || document)?.dataset.mood || '')) $$('.mood', moodGroup || document)[0]?.focus();
      return;
    }

    isSubmitting = true;
    const workflow = $('#check-in-panel');
    workflow?.setAttribute('aria-busy', 'true');
    finishButton.disabled = true;
    finishButton.setAttribute('aria-busy', 'true');
    finishButton.textContent = editingEntryId ? 'Saving changes…' : $('#save-checkin-history')?.checked ? 'Saving check-in…' : 'Preparing summary…';
    setStatus(liveStatus, editingEntryId ? 'Saving changes to your existing check-in…' : $('#save-checkin-history')?.checked ? 'Saving your check-in…' : 'Preparing your check-in summary…');
    await new Promise((resolve) => window.requestAnimationFrame ? window.requestAnimationFrame(resolve) : window.setTimeout(resolve, 0));

    try {
      latestReport = validation.report;
      const previous = editingEntryId ? savedCheckins.find((item) => item.id === editingEntryId) : null;
      currentCheckin = {
        ...(previous ? { id: previous.id } : {}),
        createdAt: previous?.createdAt || new Date().toISOString(),
        mood: validation.report.selfReportedMood,
        intensity: validation.report.selfReportedIntensity,
        reflection: reflection?.value.trim() || ''
      };
      const saveResult = saveCurrentCheckin(currentCheckin);
      if (saveResult.error) throw new Error(saveResult.error);
      if (saveResult.record) currentCheckin = saveResult.record;
      if (saveResult.updated) setEditMode(null);
      renderDashboard(currentCheckin);

      const copy = $('#result-copy');
      const recommendation = $('#result-suggestion');
      const resultTitle = $('#result-heading');
      const wasEdit = Boolean(saveResult.updated);
      if (resultTitle) resultTitle.textContent = wasEdit ? 'Your saved check-in was updated' : saveResult.saved ? 'Your check-in was saved' : 'Your check-in summary';
      if (copy) copy.textContent = validation.summary + (wasEdit ? ' Your existing history entry was updated.' : saveResult.saved ? ' This check-in is saved on this device.' : ' This summary is not saved to Mood History.');
      setStatus(recommendation, latestReport.recommendation);
      resultPanel.hidden = false;
      workflow?.setAttribute('aria-busy', 'false');
      finishButton.removeAttribute('aria-busy');
      finishButton.textContent = wasEdit ? 'Changes saved' : saveResult.saved ? 'Check-in saved' : 'Summary ready';
      isSubmitting = true;
      setStatus(liveStatus, wasEdit ? 'Saved changes to your previous check-in.' : saveResult.saved ? 'Check-in saved on this device.' : 'Summary ready. This check-in was not saved to history.');
      resultPanel.focus({ preventScroll: true });
      resultPanel.scrollIntoView?.({ behavior: window.matchMedia('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth', block: 'nearest' });
    } catch (error) {
      isSubmitting = false;
      workflow?.setAttribute('aria-busy', 'false');
      finishButton.removeAttribute('aria-busy');
      finishButton.disabled = false;
      updateFinishButtonLabel();
      if (!historyStorageAvailable) renderDashboard(currentCheckin);
      setStatus(liveStatus, error?.message || 'Your check-in could not be saved. Please try again.');
    }
  });

  $('#reset')?.addEventListener('click', () => resetCheckinForm({ focus: true, message: 'Ready for another check-in.' }));
  window.addEventListener('mindful:view-user', () => renderDashboard(currentCheckin));
})();
